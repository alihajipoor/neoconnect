//! The icon Windows already draws for an executable.
//!
//! The picker shows a list of programs, and a list of programs without
//! icons is a list of names to read rather than a set of things to
//! recognise. Windows knows the icon -- it is the one on the taskbar --
//! so nothing here decides anything, it only fetches what the shell
//! would draw and turns it into something a web view can display.
//!
//! # Why a PNG is written by hand
//!
//! The shell gives an `HICON`, GDI gives pixels, and a web view wants an
//! image format. Pulling in an encoder for that would be a dependency
//! carried by a LocalSystem service for the sake of a settings screen.
//! A PNG with stored (uncompressed) deflate blocks is a valid PNG, is
//! about sixty lines, and an icon is small enough that the wasted bytes
//! do not matter -- they are base64'd once and cached.

use std::ffi::OsStr;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS,
};
use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

/// The icon for an executable, as a base64 PNG ready for a `data:` URL.
///
/// `None` when the shell has nothing to give, which is normal for some
/// binaries -- the picker shows a placeholder rather than pretending.
pub fn icon_png_base64(path: &str) -> Option<String> {
    let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect();

    // SAFETY: zeroed is a valid SHFILEINFOW; the call fills it in.
    let mut info: SHFILEINFOW = unsafe { std::mem::zeroed() };
    // SAFETY: `wide` is null-terminated and `info` is owned here.
    let ok = unsafe {
        SHGetFileInfoW(
            wide.as_ptr(),
            0,
            &mut info,
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if ok == 0 || info.hIcon.is_null() {
        return None;
    }
    let icon = info.hIcon;
    let pixels = rgba_from_icon(icon);
    // SAFETY: the icon came from SHGetFileInfoW and is ours to free.
    unsafe { DestroyIcon(icon) };

    let (width, height, rgba) = pixels?;
    Some(base64(&png(width, height, &rgba)))
}

/// Straight-alpha RGBA for an icon, with the mask applied.
///
/// The colour bitmap's alpha channel is meaningless for older icons --
/// it is all zeroes -- and trusting it produces a completely
/// transparent image. The mask is the authority in that case: a zero bit
/// means opaque, which is the opposite of what one expects and the sort
/// of thing that is only obvious once every icon has come out blank.
fn rgba_from_icon(icon: *mut std::ffi::c_void) -> Option<(u32, u32, Vec<u8>)> {
    // SAFETY: zeroed is a valid ICONINFO; GetIconInfo fills it and hands
    // over two bitmaps that must be deleted below.
    let mut ii: ICONINFO = unsafe { std::mem::zeroed() };
    // SAFETY: `icon` is a live icon handle.
    if unsafe { GetIconInfo(icon, &mut ii) } == 0 {
        return None;
    }

    let colour = read_bitmap(ii.hbmColor);
    let mask = read_bitmap(ii.hbmMask);
    // SAFETY: both handles came from GetIconInfo and are not used again.
    unsafe {
        if !ii.hbmColor.is_null() {
            DeleteObject(ii.hbmColor);
        }
        if !ii.hbmMask.is_null() {
            DeleteObject(ii.hbmMask);
        }
    }

    let (width, height, mut bgra) = colour?;
    if bgra.len() < (width * height * 4) as usize {
        return None;
    }

    let opaque = bgra.chunks_exact(4).any(|p| p[3] != 0);
    if !opaque {
        if let Some((mw, mh, m)) = mask {
            if mw == width && mh == height && m.len() >= bgra.len() {
                for (i, pixel) in bgra.chunks_exact_mut(4).enumerate() {
                    // Mask black (0) means show the colour pixel.
                    pixel[3] = if m[i * 4] == 0 { 255 } else { 0 };
                }
            }
        } else {
            for pixel in bgra.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
        }
    }

    // BGRA as GDI hands it over, RGBA as PNG wants it.
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Some((width, height, bgra))
}

/// A GDI bitmap as top-down 32-bit BGRA.
fn read_bitmap(bitmap: *mut std::ffi::c_void) -> Option<(u32, u32, Vec<u8>)> {
    if bitmap.is_null() {
        return None;
    }
    // SAFETY: zeroed is a valid BITMAP; GetObjectW fills it.
    let mut bm: BITMAP = unsafe { std::mem::zeroed() };
    // SAFETY: `bitmap` is a live GDI bitmap handle.
    let got = unsafe {
        GetObjectW(bitmap, size_of::<BITMAP>() as i32, &mut bm as *mut _ as *mut _)
    };
    if got == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
        return None;
    }
    let (width, height) = (bm.bmWidth as u32, bm.bmHeight as u32);

    // SAFETY: zeroed is a valid BITMAPINFO for a 32bpp top-down DIB once
    // the header fields below are set.
    let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
    bmi.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = width as i32;
    // Negative: rows top-down, so the buffer matches PNG's order and
    // nothing has to be flipped afterwards.
    bmi.bmiHeader.biHeight = -(height as i32);
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;

    let mut pixels = vec![0u8; (width * height * 4) as usize];
    // SAFETY: a screen DC is valid for GetDIBits and released below.
    let dc = unsafe { GetDC(std::ptr::null_mut()) };
    // SAFETY: the buffer is exactly width*height*4 bytes, which is what
    // the header above describes.
    let rows = unsafe {
        GetDIBits(
            dc,
            bitmap,
            0,
            height,
            pixels.as_mut_ptr() as *mut _,
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };
    // SAFETY: the DC came from GetDC and is not used again.
    unsafe { ReleaseDC(std::ptr::null_mut(), dc) };
    if rows == 0 {
        return None;
    }
    Some((width, height, pixels))
}

// ---------------------------------------------------------------- png

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in data {
        a = (a + byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

/// zlib stream using stored blocks: valid, and no compressor needed.
fn deflate_stored(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    let mut at = 0usize;
    loop {
        let take = (data.len() - at).min(65_535);
        let last = if at + take >= data.len() { 1u8 } else { 0u8 };
        out.push(last);
        out.extend_from_slice(&(take as u16).to_le_bytes());
        out.extend_from_slice(&(!(take as u16)).to_le_bytes());
        out.extend_from_slice(&data[at..at + take]);
        at += take;
        if last == 1 {
            break;
        }
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn chunk(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 12);
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    let mut crc_input = Vec::with_capacity(body.len() + 4);
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(body);
    out.extend_from_slice(&crc_input);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
    out
}

fn png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    // Every scanline carries a filter byte; 0 means "no filter".
    let mut raw = Vec::with_capacity(rgba.len() + height as usize);
    for row in 0..height as usize {
        raw.push(0);
        let start = row * width as usize * 4;
        raw.extend_from_slice(&rgba[start..start + width as usize * 4]);
    }

    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit, RGBA, no interlace

    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    out.extend_from_slice(&chunk(b"IHDR", &header));
    out.extend_from_slice(&chunk(b"IDAT", &deflate_stored(&raw)));
    out.extend_from_slice(&chunk(b"IEND", &[]));
    out
}

fn base64(data: &[u8]) -> String {
    const SET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for group in data.chunks(3) {
        let b = [group[0], *group.get(1).unwrap_or(&0), *group.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(SET[(n >> 18) as usize & 63] as char);
        out.push(SET[(n >> 12) as usize & 63] as char);
        out.push(if group.len() > 1 { SET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if group.len() > 2 { SET[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_known_answers() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn crc32_matches_the_known_answer() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn adler32_matches_the_known_answer() {
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
    }

    #[test]
    fn a_png_is_well_formed() {
        // One opaque red pixel, checked structurally rather than by
        // eye: signature, the three chunks in order, and the declared
        // dimensions.
        let bytes = png(1, 1, &[255, 0, 0, 255]);
        assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(&bytes[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), 1);
        assert_eq!(u32::from_be_bytes(bytes[20..24].try_into().unwrap()), 1);
        let tail = &bytes[bytes.len() - 8..];
        assert_eq!(&tail[4..8], &crc32(b"IEND").to_be_bytes());
        assert!(bytes.windows(4).any(|w| w == b"IDAT"));
    }
}

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
//! do not matter -- they are base64'd once and cached, which as of this
//! change is true rather than aspirational.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::sync::Mutex;

use windows_sys::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS,
};
use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

/// The cache the module header has always claimed.
///
/// It said icons "are base64'd once and cached" and there was no cache
/// anywhere, so every answer was recomputed from scratch: the shell
/// consulted, GDI asked for pixels, a PNG built and base64'd, once per
/// product. The picker re-lists every fifteen seconds while it is open
/// (`RESCAN_INTERVAL_MS`), so on a machine with thirty user
/// applications that is thirty icon extractions a quarter-minute,
/// indefinitely, inside a LocalSystem service, for pictures that had
/// not changed.
///
/// Keyed on the path *and* the file's modification time, so an
/// application that updates gets its new icon without anything having
/// to notice. That key is also why caching a `None` is safe here, where
/// `OwnerLookup` learned the opposite lesson: its failures were keyed
/// on a process id Windows reuses, so a cached miss answered for a
/// different program. A path and an mtime identify exactly one set of
/// bytes, and if those bytes have no icon today they have none in
/// fifteen seconds either.
static ICONS: Mutex<Option<HashMap<(String, Option<std::time::SystemTime>), Option<String>>>> =
    Mutex::new(None);

/// Beyond this the cache is cleared rather than grown.
///
/// Applications come and go, and a map that only ever grows inside a
/// service that runs from boot is a leak with a slow fuse. Dropping
/// everything is the right response rather than evicting cleverly: the
/// cost of a miss is one extraction, and the picker will refill what it
/// still needs on its next sweep.
const MAX_CACHED_ICONS: usize = 512;

/// The icon for an executable, as a base64 PNG ready for a `data:` URL.
///
/// `None` when the shell has nothing to give, which is normal for some
/// binaries -- the picker shows a placeholder rather than pretending.
pub fn icon_png_base64(path: &str) -> Option<String> {
    let stamp = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    let key = (path.to_string(), stamp);

    if let Ok(mut guard) = ICONS.lock() {
        if let Some(found) = guard.as_ref().and_then(|m| m.get(&key)) {
            return found.clone();
        }
        // A poisoned or absent map is rebuilt rather than propagated:
        // losing the cache costs time, never an answer.
        guard.get_or_insert_with(HashMap::new);
    }

    let encoded = encode_icon(path);

    if let Ok(mut guard) = ICONS.lock() {
        if let Some(map) = guard.as_mut() {
            if map.len() >= MAX_CACHED_ICONS {
                map.clear();
            }
            map.insert(key, encoded.clone());
        }
    }
    encoded
}

/// The extraction itself, unchanged and uncached.
fn encode_icon(path: &str) -> Option<String> {
    let (width, height, rgba) = icon_rgba(path)?;
    Some(base64(&png(width, height, &rgba)))
}

/// The shell's large icon for `path`, as straight-alpha RGBA.
///
/// Split from the PNG encoding so the GDI half -- the half the header's
/// "every icon has come out blank" story is about -- can be tested
/// against a real executable rather than only against buffers.
fn icon_rgba(path: &str) -> Option<(u32, u32, Vec<u8>)> {
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
    pixels
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

    let (width, height, bgra) = colour?;
    let rgba = to_rgba(width, height, bgra, mask)?;
    Some((width, height, rgba))
}

/// Turns what GDI hands over into straight-alpha RGBA.
///
/// Split out from the Win32 above because this part is arithmetic, and
/// the rule it implements is the one the header calls "only obvious
/// once every icon has come out blank". A 32-bit icon carries its own
/// alpha; an older one carries none, and its transparency lives in a
/// separate mask bitmap where black means *show this pixel*. Read an
/// unmasked, alpha-less icon literally and every pixel is transparent,
/// so the settings screen fills with nothing and looks like a rendering
/// bug rather than a decoding one.
///
/// Takes buffers rather than handles so it can be tested without
/// Windows, an icon, or a desktop -- the same reason `compile_filter`
/// and the netsh argument list are their own functions.
fn to_rgba(
    width: u32,
    height: u32,
    mut bgra: Vec<u8>,
    mask: Option<(u32, u32, Vec<u8>)>,
) -> Option<Vec<u8>> {
    if bgra.len() < (width * height * 4) as usize {
        return None;
    }

    // Any non-zero alpha means the icon brought its own, and inventing
    // one over the top would flatten a transparent background to solid.
    let opaque = bgra.chunks_exact(4).any(|p| p[3] != 0);
    if !opaque {
        match mask {
            Some((mw, mh, m)) if mw == width && mh == height && m.len() >= bgra.len() => {
                for (i, pixel) in bgra.chunks_exact_mut(4).enumerate() {
                    // Mask black (0) means show the colour pixel.
                    pixel[3] = if m[i * 4] == 0 { 255 } else { 0 };
                }
            }
            // No mask, or one that does not describe this bitmap. Fully
            // opaque is the only safe reading: the alternative is an
            // icon nobody can see.
            _ => {
                for pixel in bgra.chunks_exact_mut(4) {
                    pixel[3] = 255;
                }
            }
        }
    }

    // BGRA as GDI hands it over, RGBA as PNG wants it.
    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Some(bgra)
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
    use super::to_rgba;

    /// Two pixels, BGRA, with the alpha the caller asks for.
    fn bgra(alpha: [u8; 2]) -> Vec<u8> {
        vec![
            10, 20, 30, alpha[0], // blue, green, red, alpha
            40, 50, 60, alpha[1],
        ]
    }

    /// The bug the module header is about.
    ///
    /// An older icon carries no alpha at all. Read literally, every
    /// pixel is transparent and the settings screen fills with nothing
    /// -- which reads as a rendering fault rather than a decoding one,
    /// and is "only obvious once every icon has come out blank".
    #[test]
    fn an_icon_with_no_alpha_and_no_mask_is_shown_rather_than_hidden() {
        let out = to_rgba(2, 1, bgra([0, 0]), None).expect("should decode");
        assert_eq!(out[3], 255);
        assert_eq!(out[7], 255);
    }

    /// Black in the mask means show the pixel. Getting this inverted
    /// produces an icon that is exactly its own negative space.
    #[test]
    fn the_mask_decides_which_pixels_show_when_there_is_no_alpha() {
        // First pixel masked black (show), second white (hide).
        let mask = vec![0, 0, 0, 0, 255, 255, 255, 255];
        let out = to_rgba(2, 1, bgra([0, 0]), Some((2, 1, mask))).expect("should decode");
        assert_eq!(out[3], 255, "a black mask pixel must be shown");
        assert_eq!(out[7], 0, "a white mask pixel must be hidden");
    }

    /// A 32-bit icon brings its own alpha, and inventing one over the
    /// top would flatten a transparent background into a solid block.
    #[test]
    fn an_icon_that_carries_alpha_keeps_it() {
        let mask = vec![255, 255, 255, 255, 255, 255, 255, 255];
        let out = to_rgba(2, 1, bgra([128, 0]), Some((2, 1, mask))).expect("should decode");
        assert_eq!(out[3], 128, "the icon's own alpha was overwritten");
        assert_eq!(out[7], 0);
    }

    /// A mask that does not describe this bitmap is not evidence about
    /// it. Opaque beats invisible.
    #[test]
    fn a_mask_of_the_wrong_size_is_ignored_rather_than_trusted() {
        let wrong = vec![255; 4];
        let out = to_rgba(2, 1, bgra([0, 0]), Some((1, 1, wrong))).expect("should decode");
        assert_eq!(out[3], 255);
        assert_eq!(out[7], 255);
    }

    /// GDI hands over BGRA; PNG wants RGBA.
    #[test]
    fn the_channels_end_up_in_png_order() {
        let out = to_rgba(1, 1, vec![10, 20, 30, 255], None).expect("should decode");
        assert_eq!(&out[..3], &[30, 20, 10], "blue and red were not swapped");
    }

    /// A buffer shorter than its declared size is refused rather than
    /// indexed past the end.
    #[test]
    fn a_truncated_bitmap_is_refused() {
        assert!(to_rgba(4, 4, vec![0; 8], None).is_none());
    }

    use super::*;

    /// The whole GDI path against a real executable, which nothing ran
    /// before: the shell's icon, its bitmaps, the mask rule, the channel
    /// swap. What is asserted is the failure the header names -- an icon
    /// that decodes to nothing visible -- and its opposite, an icon whose
    /// transparent background was flattened to opaque. Explorer's icon
    /// has both a shape and a background around it on every Windows.
    #[test]
    fn a_real_executable_gives_an_icon_that_is_neither_blank_nor_a_solid_block() {
        let (width, height, rgba) =
            icon_rgba(r"C:\Windows\explorer.exe").expect("the shell has an icon for explorer.exe");
        assert!(width >= 16 && height >= 16, "a large icon, got {width}x{height}");
        assert_eq!(rgba.len(), (width * height * 4) as usize);

        let alphas: Vec<u8> = rgba.chunks_exact(4).map(|pixel| pixel[3]).collect();
        let visible = alphas.iter().filter(|&&a| a > 0).count();
        let transparent = alphas.iter().filter(|&&a| a == 0).count();
        assert!(visible > alphas.len() / 10, "the icon came out blank: {visible} visible pixels");
        assert!(transparent > 0, "the background was flattened: no transparent pixel at all");

        // And it survives the encode the picker actually sends.
        let encoded = encode_icon(r"C:\Windows\explorer.exe").expect("encodes");
        assert!(encoded.starts_with("iVBORw0KGgo"), "a base64 PNG signature");
    }

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

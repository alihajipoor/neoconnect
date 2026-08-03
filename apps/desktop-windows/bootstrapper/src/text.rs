//! Text, drawn glyph by glyph into the frame buffer.
//!
//! Fonts are read from the Windows font directory rather than embedded.
//! Segoe UI has shipped with every version of Windows this installer
//! supports, so a copy of it would only make the download bigger and
//! raise a redistribution question for no gain.

use tiny_skia::{Pixmap, PremultipliedColorU8};

pub struct Fonts {
    regular: fontdue::Font,
    bold: fontdue::Font,
}

/// Loads the two weights the installer uses.
///
/// Returns `None` rather than panicking if neither can be read: an
/// installer that cannot find a font should still be able to say so,
/// and the caller falls back to a message box.
pub fn load() -> Option<Fonts> {
    let dir = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let read = |name: &str| std::fs::read(format!(r"{dir}\Fonts\{name}")).ok();

    let settings = fontdue::FontSettings::default();
    let regular = fontdue::Font::from_bytes(read("segoeui.ttf")?, settings).ok()?;
    // Falls back to the regular weight rather than failing: a heading
    // in the wrong weight is a cosmetic problem, no installer at all is
    // not.
    let bold = read("segoeuib.ttf")
        .and_then(|b| fontdue::Font::from_bytes(b, settings).ok())
        .unwrap_or_else(|| regular.clone());

    Some(Fonts { regular, bold })
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Weight {
    Regular,
    Bold,
}

impl Fonts {
    fn face(&self, weight: Weight) -> &fontdue::Font {
        match weight {
            Weight::Regular => &self.regular,
            Weight::Bold => &self.bold,
        }
    }

    /// Total advance width of `text`, for centring it.
    pub fn width(&self, text: &str, size: f32, weight: Weight) -> f32 {
        let face = self.face(weight);
        text.chars().map(|c| face.metrics(c, size).advance_width).sum()
    }

    /// Draws `text` with its left edge at `x` and its baseline at `y`.
    ///
    /// Alpha-blends each glyph's coverage over what is already there,
    /// which is what lets text sit on the gradient without a box of
    /// background colour around it.
    pub fn draw(
        &self,
        pixmap: &mut Pixmap,
        text: &str,
        mut x: f32,
        y: f32,
        size: f32,
        weight: Weight,
        colour: (u8, u8, u8),
        opacity: f32,
    ) {
        let face = self.face(weight);
        let (width, height) = (pixmap.width() as i32, pixmap.height() as i32);

        for ch in text.chars() {
            let (metrics, coverage) = face.rasterize(ch, size);
            let left = x as i32 + metrics.xmin;
            let top = y as i32 - metrics.height as i32 - metrics.ymin;

            for row in 0..metrics.height {
                let py = top + row as i32;
                if py < 0 || py >= height {
                    continue;
                }
                for col in 0..metrics.width {
                    let px = left + col as i32;
                    if px < 0 || px >= width {
                        continue;
                    }
                    let a = coverage[row * metrics.width + col] as f32 / 255.0 * opacity;
                    if a <= 0.0 {
                        continue;
                    }
                    blend(pixmap, px, py, colour, a);
                }
            }
            x += metrics.advance_width;
        }
    }
}

/// Source-over blend of one opaque colour at `alpha` onto one pixel.
///
/// The buffer is premultiplied, and at full opacity everywhere it is
/// drawn on, so the destination alpha never changes -- which keeps this
/// to a plain lerp per channel instead of a general compositing step.
fn blend(pixmap: &mut Pixmap, x: i32, y: i32, colour: (u8, u8, u8), alpha: f32) {
    let index = (y as u32 * pixmap.width() + x as u32) as usize;
    let pixels = pixmap.pixels_mut();
    let Some(dst) = pixels.get_mut(index) else { return };

    let mix = |from: u8, to: u8| (from as f32 * (1.0 - alpha) + to as f32 * alpha).round() as u8;
    let blended = PremultipliedColorU8::from_rgba(
        mix(dst.red(), colour.0),
        mix(dst.green(), colour.1),
        mix(dst.blue(), colour.2),
        255,
    );
    if let Some(value) = blended {
        *dst = value;
    }
}

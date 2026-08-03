//! Everything the window draws.
//!
//! Vector work redrawn at whatever size the display asks for, rather
//! than a pre-rendered bitmap. A bitmap would have been less code and
//! would blur the moment somebody ran this at 150%, which is most
//! laptops.

use tiny_skia::{
    Color, FillRule, Paint, PathBuilder, Pixmap, Point, RadialGradient, Rect, Shader,
    SpreadMode, Transform,
};

use crate::text::{Fonts, Weight};

/// Logical size. Physical pixels are this times the scale factor.
pub const WIDTH: f32 = 440.0;
pub const HEIGHT: f32 = 540.0;

const BG: Color32 = Color32(0x0B, 0x0A, 0x14);
const TEXT: Color32 = Color32(0xFF, 0xFF, 0xFF);
const MUTED: Color32 = Color32(0x8B, 0x87, 0xA3);
const VIOLET: Color32 = Color32(0x6D, 0x4A, 0xFF);
const CYAN: Color32 = Color32(0x22, 0xD3, 0xEE);
const DANGER: Color32 = Color32(0xF8, 0x71, 0x71);

#[derive(Clone, Copy)]
pub struct Color32(pub u8, pub u8, pub u8);

impl Color32 {
    fn to_color(self, alpha: f32) -> Color {
        Color::from_rgba8(self.0, self.1, self.2, (alpha * 255.0) as u8)
    }
    fn tuple(self) -> (u8, u8, u8) {
        (self.0, self.1, self.2)
    }
    /// Mixes towards white, for the hover state.
    fn lighten(self, amount: f32) -> Self {
        let m = |c: u8| (c as f32 + (255.0 - c as f32) * amount) as u8;
        Color32(m(self.0), m(self.1), m(self.2))
    }
    fn darken(self, amount: f32) -> Self {
        let m = |c: u8| (c as f32 * (1.0 - amount)) as u8;
        Color32(m(self.0), m(self.1), m(self.2))
    }
}

/// What the window is doing, which is all that changes between frames.
pub enum Phase {
    Idle { hovering: bool, pressing: bool },
    Installing { spinner: f32 },
    Failed(String),
}

pub struct Layout {
    pub scale: f32,
}

impl Layout {
    /// The Install button, in logical coordinates.
    pub fn button(&self) -> Rect {
        Rect::from_xywh((WIDTH - 220.0) / 2.0, 328.0, 220.0, 50.0).expect("constant rect")
    }

    /// The close affordance, top right.
    pub fn close(&self) -> Rect {
        Rect::from_xywh(WIDTH - 44.0, 14.0, 30.0, 30.0).expect("constant rect")
    }
}

pub fn paint(
    pixmap: &mut Pixmap,
    fonts: &Fonts,
    layout: &Layout,
    phase: &Phase,
    logo: Option<&Pixmap>,
) {
    let s = layout.scale;
    pixmap.fill(BG.to_color(1.0));

    // A violet bloom behind the mark, so the top of the window has some
    // depth instead of being a flat rectangle. The same treatment the
    // app's own dashboard uses behind its connect button.
    glow(pixmap, WIDTH / 2.0 * s, 150.0 * s, 260.0 * s, VIOLET, 0.30);
    glow(pixmap, WIDTH * 0.82 * s, 470.0 * s, 200.0 * s, CYAN, 0.07);

    if let Some(logo) = logo {
        let size = 88.0 * s;
        let x = ((WIDTH * s) - size) / 2.0;
        draw_image(pixmap, logo, x, 84.0 * s, size);
    }

    let title = "Neoxify";
    let title_size = 30.0 * s;
    let tx = (WIDTH * s - fonts.width(title, title_size, Weight::Bold)) / 2.0;
    fonts.draw(pixmap, title, tx, 244.0 * s, title_size, Weight::Bold, TEXT.tuple(), 1.0);

    let tagline = "Private, fast, and hard to block.";
    let tag_size = 13.0 * s;
    let gx = (WIDTH * s - fonts.width(tagline, tag_size, Weight::Regular)) / 2.0;
    fonts.draw(pixmap, tagline, gx, 276.0 * s, tag_size, Weight::Regular, MUTED.tuple(), 1.0);

    // The close glyph, drawn rather than set in text so it is the same
    // weight and size on every machine.
    let close = scaled(layout.close(), s);
    cross(pixmap, close, MUTED, 1.4 * s);

    match phase {
        Phase::Idle { hovering, pressing } => {
            let fill = if *pressing {
                VIOLET.darken(0.18)
            } else if *hovering {
                VIOLET.lighten(0.12)
            } else {
                VIOLET
            };
            let button = scaled(layout.button(), s);
            rounded(pixmap, button, 25.0 * s, fill, 1.0);

            let label = "Install";
            let size = 16.0 * s;
            let lx = button.x() + (button.width() - fonts.width(label, size, Weight::Bold)) / 2.0;
            let ly = button.y() + button.height() / 2.0 + size * 0.36;
            fonts.draw(pixmap, label, lx, ly, size, Weight::Bold, TEXT.tuple(), 1.0);

            footer(pixmap, fonts, s, "Installs to C:\\Program Files\\Neoxify", MUTED, 0.75);
        }

        Phase::Installing { spinner } => {
            // Indeterminate on purpose. NSIS in silent mode reports no
            // progress, and a bar that invents its own position is a
            // small lie that always ends with a jump to 100%.
            let track = Rect::from_xywh((WIDTH - 260.0) / 2.0 * s, 348.0 * s, 260.0 * s, 6.0 * s)
                .expect("constant rect");
            rounded(pixmap, track, 3.0 * s, Color32(0x2A, 0x25, 0x40), 1.0);

            let span = track.width() * 0.32;
            let travel = track.width() + span;
            let x = track.x() - span + (spinner % 1.0) * travel;
            let visible_x = x.max(track.x());
            let visible_w = (x + span).min(track.right()) - visible_x;
            if visible_w > 0.0 {
                if let Some(chip) = Rect::from_xywh(visible_x, track.y(), visible_w, track.height())
                {
                    rounded(pixmap, chip, 3.0 * s, VIOLET, 1.0);
                }
            }

            footer(pixmap, fonts, s, "Installing...", MUTED, 1.0);
        }

        Phase::Failed(message) => {
            let size = 13.0 * s;
            let x = (WIDTH * s - fonts.width(message, size, Weight::Regular)) / 2.0;
            fonts.draw(pixmap, message, x.max(24.0 * s), 352.0 * s, size, Weight::Regular, DANGER.tuple(), 1.0);
            footer(pixmap, fonts, s, "Close this window and try again.", MUTED, 0.75);
        }
    }
}

fn footer(pixmap: &mut Pixmap, fonts: &Fonts, s: f32, text: &str, colour: Color32, opacity: f32) {
    let size = 12.0 * s;
    let x = (WIDTH * s - fonts.width(text, size, Weight::Regular)) / 2.0;
    fonts.draw(pixmap, text, x, 452.0 * s, size, Weight::Regular, colour.tuple(), opacity);
}

fn scaled(rect: Rect, s: f32) -> Rect {
    Rect::from_xywh(rect.x() * s, rect.y() * s, rect.width() * s, rect.height() * s)
        .expect("scaling a valid rect keeps it valid")
}

fn rounded(pixmap: &mut Pixmap, rect: Rect, radius: f32, colour: Color32, alpha: f32) {
    let mut path = PathBuilder::new();
    let r = radius.min(rect.width() / 2.0).min(rect.height() / 2.0);
    let (l, t, right, b) = (rect.left(), rect.top(), rect.right(), rect.bottom());

    path.move_to(l + r, t);
    path.line_to(right - r, t);
    path.quad_to(right, t, right, t + r);
    path.line_to(right, b - r);
    path.quad_to(right, b, right - r, b);
    path.line_to(l + r, b);
    path.quad_to(l, b, l, b - r);
    path.line_to(l, t + r);
    path.quad_to(l, t, l + r, t);
    path.close();

    let Some(path) = path.finish() else { return };
    let mut paint = Paint::default();
    paint.set_color(colour.to_color(alpha));
    paint.anti_alias = true;
    pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
}

/// A soft radial wash, fading to nothing at its edge.
fn glow(pixmap: &mut Pixmap, cx: f32, cy: f32, radius: f32, colour: Color32, strength: f32) {
    let Some(shader) = RadialGradient::new(
        Point::from_xy(cx, cy),
        Point::from_xy(cx, cy),
        radius,
        vec![
            tiny_skia::GradientStop::new(0.0, colour.to_color(strength)),
            tiny_skia::GradientStop::new(1.0, colour.to_color(0.0)),
        ],
        SpreadMode::Pad,
        Transform::identity(),
    ) else {
        return;
    };

    let mut paint = Paint::default();
    paint.shader = shader;
    paint.anti_alias = true;
    let area = Rect::from_xywh(cx - radius, cy - radius, radius * 2.0, radius * 2.0);
    if let Some(area) = area {
        pixmap.fill_rect(area, &paint, Transform::identity(), None);
    }
}

fn cross(pixmap: &mut Pixmap, rect: Rect, colour: Color32, thickness: f32) {
    let inset = rect.width() * 0.32;
    let mut path = PathBuilder::new();
    path.move_to(rect.left() + inset, rect.top() + inset);
    path.line_to(rect.right() - inset, rect.bottom() - inset);
    path.move_to(rect.right() - inset, rect.top() + inset);
    path.line_to(rect.left() + inset, rect.bottom() - inset);
    let Some(path) = path.finish() else { return };

    let mut paint = Paint::default();
    paint.set_color(colour.to_color(1.0));
    paint.anti_alias = true;
    let stroke = tiny_skia::Stroke { width: thickness, ..Default::default() };
    pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
}

/// Blits the mark, scaled to `size`, honouring its alpha.
fn draw_image(pixmap: &mut Pixmap, image: &Pixmap, x: f32, y: f32, size: f32) {
    let scale = size / image.width() as f32;
    let mut paint = Paint::default();
    paint.shader = Shader::SolidColor(Color::TRANSPARENT);

    let pattern = tiny_skia::Pattern::new(
        image.as_ref(),
        SpreadMode::Pad,
        tiny_skia::FilterQuality::Bicubic,
        1.0,
        Transform::from_scale(scale, scale),
    );
    paint.shader = pattern;
    paint.anti_alias = true;

    if let Some(area) = Rect::from_xywh(x, y, size, size) {
        pixmap.fill_rect(area, &paint, Transform::from_translate(x, y), None);
    }
}

"""Renders the Neoxify store art from the mark's own geometry.

Not traced from an exported PNG: the same numbers the app and the
invoices draw from (apps/backend/src/modules/brand/logo.ts), so the store
art cannot drift from the product's icon.

Drawn at 4x and downsampled, which is how the round dash caps and the
ring edge come out smooth -- Pillow's arc has no antialiasing of its own.
"""
from PIL import Image, ImageDraw, ImageFont
import io
import math
import os

# Straight from logo.ts.
VIEWBOX = 64.0
CENTRE = 32.0
RING_RADIUS = 21.0
RING_WIDTH = 7.0
CORE_RADIUS = 8.0
ROTATION_DEG = -58.0
DASH_ON = 96.0
DASH_PERIOD = 132.0

VIOLET = (0x8B, 0x5C, 0xF6)
CYAN = (0x22, 0xD3, 0xEE)
# The app's own near-black surface, so the art sits in the product's world
# rather than on an arbitrary backdrop.
BG_TOP = (0x0B, 0x0A, 0x12)
BG_BOTTOM = (0x14, 0x10, 0x24)

SS = 4  # supersample factor

# The app's own typeface, from the app's own asset. Using the real face
# rather than a system lookalike is what stops the store page from
# reading as a different product.
WORDMARK_WOFF2 = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "apps", "desktop-windows", "src", "assets", "Vazirmatn-variable.woff2",
)


def wordmark_font_bytes():
    """The app's Vazirmatn, as a static bold TTF Pillow can open.

    Two conversions, both in memory so nothing derived is committed and
    the font can never drift from the one the app ships: woff2 -> ttf
    (Pillow cannot read woff2), then a variable-weight axis pinned to 700
    (Pillow's variation support depends on how FreeType was built, so
    instantiating here rather than asking Pillow to is the portable
    route).

    Needs `pip install fonttools brotli`.
    """
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont

    font = TTFont(WORDMARK_WOFF2)
    font.flavor = None  # drop woff2 compression
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": 700})
    buf = io.BytesIO()
    font.save(buf)
    buf.seek(0)
    return buf


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_bg(w, h):
    """Vertical near-black wash, with a soft violet glow behind the mark."""
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=lerp(BG_TOP, BG_BOTTOM, y / max(1, h - 1)))
    return img


def add_glow(img, cx, cy, radius):
    """A radial violet bloom, the same treatment the app gives the mark.

    Composited as many translucent circles rather than a blur, which keeps
    this dependency-free and is indistinguishable at these sizes.
    """
    glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    steps = 60
    for i in range(steps, 0, -1):
        t = i / steps
        r = radius * t
        alpha = int(26 * (1 - t) ** 2)
        if alpha <= 0:
            continue
        gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(*VIOLET, alpha))
    return Image.alpha_composite(img.convert("RGBA"), glow)


def gradient_mask_fill(size, mask, box=None):
    """Paints the violet->cyan diagonal through a shape mask.

    The SVG gradient runs corner to corner (x1,y1 = 0,0 -> x2,y2 = 1,1),
    so the ramp is along x+y rather than either axis alone.

    `box` is the rectangle the ramp spans, defaulting to the whole
    canvas. It exists because SVG gradients default to
    gradientUnits="objectBoundingBox" -- each shape gets the full ramp
    across *its own* bounding box, not a slice of one shared ramp. The
    mark has two shapes of very different sizes, so this is the whole
    difference between the small core circle reading violet-to-cyan as
    it does in the app, and reading as one flat blue disc.
    """
    w, h = size
    x0, y0, x1, y1 = box if box else (0, 0, w, h)
    start, span = x0 + y0, max(1e-6, (x1 - x0) + (y1 - y0))

    grad = Image.new("RGB", size)
    gd = ImageDraw.Draw(grad)
    for i in range(w + h):
        t = min(1.0, max(0.0, (i - start) / span))
        gd.line([(i, 0), (0, i)], fill=lerp(VIOLET, CYAN, t))
    out = Image.new("RGBA", size, (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def draw_mark(px):
    """The mark alone, on transparency, at `px` square."""
    s = px * SS
    scale = s / VIEWBOX

    cx = cy = CENTRE * scale
    r = RING_RADIUS * scale
    width = RING_WIDTH * scale

    # --- the broken ring -------------------------------------------------
    ring = Image.new("L", (s, s), 0)
    rd = ImageDraw.Draw(ring)

    # dasharray 96 on / 36 off over a 132 period is exactly one stroke and
    # one gap, rotated -58 degrees.
    sweep = (DASH_ON / DASH_PERIOD) * 360.0
    stroke_px = int(round(width))

    # Pillow grows an arc's stroke *inward* from the bounding box, so a box
    # at radius r puts the band's centreline at r - width/2. SVG centres a
    # stroke on the path. Inflating the box by half the stroke restores
    # that -- and it is what makes the round caps meet the arc cleanly,
    # since the caps sit on radius r as the path does. Without it every
    # cap has a visible notch where the band's square end pokes out.
    ra = r + stroke_px / 2
    rd.arc(
        [cx - ra, cy - ra, cx + ra, cy + ra],
        start=ROTATION_DEG,
        end=ROTATION_DEG + sweep,
        fill=255,
        width=stroke_px,
    )

    # Round caps: circles centred on the path's endpoints, sized from the
    # width the arc was actually drawn with rather than the float it came
    # from, since Pillow rounds the stroke to whole pixels.
    cap_r = stroke_px / 2
    for arc_len in (0.0, DASH_ON):
        ang = math.radians((arc_len / DASH_PERIOD) * 360.0 + ROTATION_DEG)
        ex = cx + r * math.cos(ang)
        ey = cy + r * math.sin(ang)
        rd.ellipse([ex - cap_r, ey - cap_r, ex + cap_r, ey + cap_r], fill=255)

    # --- the solid core --------------------------------------------------
    core = CORE_RADIUS * scale
    disc = Image.new("L", (s, s), 0)
    ImageDraw.Draw(disc).ellipse([cx - core, cy - core, cx + core, cy + core], fill=255)

    # Each shape gets the ramp across its own geometry bounding box, which
    # is what SVG's default gradientUnits does. Note the ring's box is the
    # r=21 circle's, stroke excluded -- objectBoundingBox is geometry only.
    art = gradient_mask_fill((s, s), ring, (cx - r, cy - r, cx + r, cy + r))
    art.alpha_composite(
        gradient_mask_fill((s, s), disc, (cx - core, cy - core, cx + core, cy + core))
    )
    return art.resize((px, px), Image.LANCZOS)


def draw_wordmark(width, text_px):
    """"Neoxify" in the product's own typeface, on transparency.

    Vazirmatn at weight 700 -- the same face the apps render in, taken
    from the app's own asset and instantiated to a static weight, rather
    than a system font that merely looks close. Painted through the same
    violet->cyan ramp as the mark, so the two read as one lockup.
    """
    font = ImageFont.truetype(wordmark_font_bytes(), text_px * SS)
    text = "Neoxify"

    # Measure before allocating: a tight canvas keeps the gradient ramp
    # spanning the letters rather than a mostly-empty box.
    left, top, right, bottom = font.getbbox(text)
    pad = text_px * SS // 4
    w, h = right - left + pad * 2, bottom - top + pad * 2

    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).text((pad - left, pad - top), text, font=font, fill=255)
    art = gradient_mask_fill((w, h), mask)
    return art.resize((max(1, w // SS), max(1, h // SS)), Image.LANCZOS)


def compose(width, height, mark_fraction, out_path, wordmark=False):
    canvas = gradient_bg(width, height)
    short = min(width, height)
    mark_px = int(short * mark_fraction)

    # The wordmark sits under the mark, and the pair is centred as a unit
    # -- centring the mark alone and hanging text off it would leave the
    # lockup visibly low on the canvas.
    word = draw_wordmark(width, int(short * 0.11)) if wordmark else None
    gap = int(short * 0.05) if word else 0
    block_h = mark_px + gap + (word.height if word else 0)
    top = (height - block_h) // 2

    canvas = add_glow(canvas, width / 2, top + mark_px / 2, mark_px * 0.95)
    canvas.alpha_composite(draw_mark(mark_px), ((width - mark_px) // 2, top))
    if word:
        canvas.alpha_composite(word, ((width - word.width) // 2, top + mark_px + gap))

    canvas.convert("RGB").save(out_path, "PNG", optimize=True)
    print("  %-34s %dx%d" % (out_path.split("\\")[-1], width, height))


if __name__ == "__main__":
    import sys
    out = sys.argv[1].rstrip("\\/")
    # 1:1 box art, required. The mark sits at ~52% so it survives being
    # scaled down to a small tile without the ring closing up visually.
    compose(1080, 1080, 0.52, out + r"\store-logo-1080x1080.png")
    compose(2160, 2160, 0.52, out + r"\store-logo-2160x2160.png")
    # 2:3 poster art, recommended.
    compose(720, 1080, 0.46, out + r"\poster-art-720x1080.png", wordmark=True)
    compose(1440, 2160, 0.46, out + r"\poster-art-1440x2160.png", wordmark=True)
    # 1:1 300x300 is handy for other listings and the website.
    compose(300, 300, 0.52, out + r"\icon-300x300.png")

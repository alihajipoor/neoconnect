"""Renders the site's social preview card and its raster icons.

WHY THIS EXISTS. Before the 2026-08 rebuild the site had no og:image at
all, so every link to it -- and the ones that matter for this audience are
Telegram links, where people actually share things -- rendered as a bare
grey rectangle. A shared link with no image is a link nobody clicks.

The mark is not redrawn here. It is imported from brand/make_store_art.py,
which draws it from the same constants the app and the invoices use
(r=21, dasharray 96/132, rotation -58). The ring has exactly one gap, and
it stops being the logo if the radius changes without the dasharray, so
nothing in this file is allowed to have an opinion about its geometry.

    python website/scripts/make-og-image.py

Needs: pillow, fonttools, brotli.

-----------------------------------------------------------------------
ONE CARD, IN LATIN SCRIPT, FOR BOTH LOCALES -- A DELIBERATE DECISION
-----------------------------------------------------------------------
The obvious move is a Persian card for the Persian pages. It is not done
here, and the reason is worth writing down so nobody "fixes" it:

Pillow cannot shape Arabic-script text. Rendering Persian needs either
libraqm/HarfBuzz compiled into Pillow, or arabic-reshaper plus python-bidi
to pre-shape and reorder the string. Checked on this machine: raqm is
absent and neither library is installed. Without them Pillow draws Persian
as isolated, unjoined letterforms in logical order -- visibly broken
Persian, on the single most-shared image the site has, to precisely the
audience that would notice.

RTL bugs have cost this product real trust before. A correct Latin card
serves both locales; a broken Persian one serves nobody. If the shaping
dependencies are ever added, a Persian variant is a small change here plus
one line in inc/partials/head.php, which already reads a per-page override.

What the card says is true and checkable: the product name, the four
protocol families it carries, and the domain. No claim, no number that
could go stale.
"""

import os
import sys

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "brand")
)

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

import make_store_art as brand  # noqa: E402

OUT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "assets", "img"
)

# 1200x630 is the size Facebook, Telegram, WhatsApp, LinkedIn and X all
# crop from. Anything smaller gets upscaled; anything larger is wasted
# bytes on a connection that cannot spare them.
OG_W, OG_H = 1200, 630

FG = (0xF4, 0xF4, 0xF8)
MUTED = (0x97, 0x97, 0xA8)


def font(px, weight=700):
    """Vazirmatn at a static weight, from the app's own woff2.

    The same face the site and the apps render in, so the card cannot look
    like a different product's.
    """
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont
    import io

    f = TTFont(brand.WORDMARK_WOFF2)
    f.flavor = None
    if "fvar" in f:
        f = instantiateVariableFont(f, {"wght": weight})
    buf = io.BytesIO()
    f.save(buf)
    buf.seek(0)
    return ImageFont.truetype(buf, px)


def make_og(path):
    canvas = brand.gradient_bg(OG_W, OG_H)

    # The violet bloom sits behind where the mark will be, not in the
    # middle of the card -- it is a light source, and a light source that
    # does not correspond to the object it lights reads as a smudge.
    mark_px = 132
    mark_x, mark_y = 88, 96
    canvas = brand.add_glow(
        canvas, mark_x + mark_px / 2, mark_y + mark_px / 2, mark_px * 1.6
    )
    canvas.alpha_composite(brand.draw_mark(mark_px), (mark_x, mark_y))

    d = ImageDraw.Draw(canvas)

    # Wordmark, painted through the same violet->cyan ramp as the mark so
    # the two read as one lockup rather than a logo beside some text.
    word = brand.draw_wordmark(OG_W, 92)
    canvas.alpha_composite(word, (mark_x + mark_px + 28, mark_y + 18))

    # The line that does the selling. Stated as fact, with nothing in it
    # that can go stale: no counts, no speeds, no "#1".
    d.text(
        (mark_x, 300),
        "Eight ways to connect.",
        font=font(64, 700),
        fill=FG,
    )
    d.text(
        (mark_x, 378),
        "Built for networks that filter hard.",
        font=font(64, 700),
        fill=MUTED,
    )

    # The protocol families, in Latin -- the words a technical buyer scans
    # for, and the reason this card works for a Persian reader too.
    d.text(
        (mark_x, 486),
        "WireGuard  ·  OpenVPN  ·  Shadowsocks  ·  VLESS REALITY",
        font=font(28, 600),
        fill=(0x22, 0xD3, 0xEE),
    )

    d.text((mark_x, 538), "neoxify.net", font=font(30, 600), fill=MUTED)

    # A hairline along the bottom, violet into cyan, in the brand's fixed
    # top-left-to-bottom-right direction.
    bar = brand.gradient_mask_fill(
        (OG_W, OG_H),
        _bottom_bar_mask(OG_W, OG_H, 8),
        (0, 0, OG_W, OG_H),
    )
    canvas.alpha_composite(bar)

    canvas.convert("RGB").save(path, "PNG", optimize=True)
    print("  %-28s %dx%d  %d bytes" % (os.path.basename(path), OG_W, OG_H, os.path.getsize(path)))


def _bottom_bar_mask(w, h, thickness):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rectangle([0, h - thickness, w, h], fill=255)
    return m


def make_icon(px, path, bg=True):
    """A square raster icon.

    The SVG favicon covers every current browser; these exist for the
    places that still will not take one -- older Safari, most RSS readers
    and bookmark managers, and the apple-touch-icon slot, which has never
    accepted SVG.
    """
    if bg:
        img = brand.gradient_bg(px, px).convert("RGBA")
        pad = int(px * 0.16)
        mark = brand.draw_mark(px - pad * 2)
        img.alpha_composite(mark, (pad, pad))
        img = img.convert("RGB")
    else:
        img = brand.draw_mark(px)

    img.save(path, "PNG", optimize=True)
    print("  %-28s %dx%d  %d bytes" % (os.path.basename(path), px, px, os.path.getsize(path)))


if __name__ == "__main__":
    out = os.path.abspath(OUT_DIR)
    os.makedirs(out, exist_ok=True)
    print("Writing to %s" % out)

    make_og(os.path.join(out, "og-default.png"))

    # 32px for the classic favicon slot, 180px for apple-touch-icon (the
    # size iOS actually asks for), 512px for the Organization logo in the
    # structured data, which Google wants at least 112px square.
    make_icon(32, os.path.join(out, "favicon-32.png"))
    make_icon(180, os.path.join(out, "apple-touch-icon.png"))
    make_icon(512, os.path.join(out, "logo-512.png"))

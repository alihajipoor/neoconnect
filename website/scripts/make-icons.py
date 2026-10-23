"""Renders the site's three raster icons from the brand's own drawing code.

    python website/scripts/make-icons.py

Needs: pillow (and whatever brand/make_store_art.py imports).

The mark is not redrawn here. It is imported from brand/make_store_art.py,
which draws it from the same constants the app and the invoices use
(r=21, dasharray 96/132, rotation -58).

The social preview cards used to be drawn here too, in Pillow, which cannot
shape Persian -- so there was one Latin card for both languages. They are
now rendered in a real browser by scripts/make-og-image.mjs, one per
language, and this file only makes the icons.
"""


import os
import sys

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "brand")
)

from PIL import Image  # noqa: E402,F401

import make_store_art as brand  # noqa: E402

OUT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "assets", "img"
)



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

    # 32px for the classic favicon slot, 180px for apple-touch-icon (the
    # size iOS actually asks for), 512px for the Organization logo in the
    # structured data, which Google wants at least 112px square.
    make_icon(32, os.path.join(out, "favicon-32.png"))
    make_icon(180, os.path.join(out, "apple-touch-icon.png"))
    make_icon(512, os.path.join(out, "logo-512.png"))

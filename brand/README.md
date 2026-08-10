# Brand art

Store-listing images for the Microsoft Partner Center submission, and the
script that renders them.

## Files

| File | Size | Where it goes |
|---|---|---|
| `store/store-logo-1080x1080.png` | 1:1 | Store logo — **required** by Partner Center |
| `store/store-logo-2160x2160.png` | 1:1 | Same, at 2x for high-DPI placements |
| `store/poster-art-720x1080.png` | 2:3 | Poster art — recommended, used in spotlight placements |
| `store/poster-art-1440x2160.png` | 2:3 | Same, at 2x |
| `store/icon-300x300.png` | 1:1 | Handy elsewhere — other listings, the website |

The poster art carries the "Neoxify" wordmark under the mark; the square
logos are the mark alone, because at tile sizes the text would be
unreadable and would only muddy the shape.

## Regenerating

```bash
pip install pillow fonttools brotli
python brand/make_store_art.py brand/store
```

The point of the script — rather than a hand-exported PNG — is that the
art is drawn from the **same numbers the product draws from**. The
geometry constants at the top of `make_store_art.py` mirror
`apps/backend/src/modules/brand/logo.ts`, and the wordmark uses the
app's own Vazirmatn asset (`apps/desktop-windows/src/assets`), converted
in memory. So a change to the mark cannot silently leave the store page
showing an older logo — re-run the script and the art follows.

Two details worth knowing before editing it, both found by comparing the
output against the real SVG rather than by reading Pillow's docs:

- **Pillow grows an arc's stroke inward from its bounding box**, while
  SVG centres a stroke on the path. The box is inflated by half the
  stroke to compensate; without that, every round cap shows a notch
  where the band's square end pokes out past it.
- **SVG gradients default to `objectBoundingBox`**, so each shape gets
  the whole violet→cyan ramp across *its own* box. Filling both shapes
  from one canvas-wide ramp makes the small core circle come out a flat
  blue instead of the violet-to-cyan it has in the app.

If the mark ever changes, check the result against
`BRAND_LOGO_SVG` in `logo.ts` rendered at the same size — that
comparison is what caught both of the above.

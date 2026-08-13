# Neoxify brand kit

Generated 2026-08-12. The SVGs are the masters; the PNGs are rendered
from them, so if you change a mark, re-render rather than editing a PNG.

## What was already here, and what is new

`store/` and `make_store_art.py` predate this kit — they were built on
2026-08-09 for the Microsoft Store and are unchanged. `make_store_art.py`
draws from the same geometry constants as the app and the invoices
(`apps/backend/src/modules/brand/logo.ts`) rather than tracing an
exported image, which is why the store art cannot drift from the icon.

New in this pass: the SVG masters, the PNG renders at social and Play
sizes, and the **Play feature graphic**, which had to be designed from
scratch because a Play listing requires one and there wasn't one.

What still does not exist anywhere: photography, illustration, and app
screenshots dressed in device frames. The website's visuals are CSS
gradients, not images — its whole image budget was one favicon. Play
also wants a set of phone screenshots, which is a design job rather than
an export. Ask and I'll do it properly.

## Files

| File | Use it for |
|---|---|
| `neoxify-mark.svg` | The logo on transparency. Anywhere the background is already ours. |
| `neoxify-avatar.svg` | The logo on its dark plate. **This is the profile picture.** |
| `neoxify-feature-graphic.svg` | Google Play feature graphic, 1024×500. |
| `neoxify-favicon.svg` | Browser tab icon, already live on the site. |
| `png/neoxify-avatar-512.png` | Play Store app icon (512×512 is exactly what Play requires). |
| `png/neoxify-avatar-1024.png` | Social profile pictures — X, Instagram, Telegram, Discord. |
| `png/neoxify-mark-*.png` | Transparent versions, for dark backgrounds only. |
| `png/neoxify-feature-graphic-1024x500.png` | Upload this one to Play. |
| `app-icons/` | Already shipping inside the apps — the Windows `.ico`, the Microsoft Store tiles. |
| `store/store-logo-1080x1080.png`, `-2160x2160` | Microsoft Store logo. Also a fine square social avatar. |
| `store/poster-art-720x1080.png`, `-1440x2160` | Microsoft Store poster art (the 2:3 portrait slot). |
| `store/icon-300x300.png` | Microsoft Store icon. |

## Use the avatar, not the mark, for profile pictures

The transparent mark is the wrong file for a profile picture. Every
platform composites it onto white somewhere — notifications, light mode,
link embeds — and the violet-to-cyan ring nearly vanishes against it.
The avatar carries its own dark plate, so it looks the same everywhere.

It is deliberately a full-bleed square with no rounded corners. Every
platform applies its own mask (a circle on most social networks, a
squircle on Android, a rounded square on Windows), and corners baked in
here would show as a dark halo inside their mask.

## Colours

| Token | Hex | |
|---|---|---|
| Primary | `#8b5cf6` | violet — gradient start |
| Highlight | `#22d3ee` | cyan — gradient end |
| Background | `#0b0b12` | the plate behind the mark |

The gradient always runs top-left to bottom-right, violet into cyan.
That direction is the brand as much as the colours are; flipping it
reads as a different product.

## The one thing to keep consistent

The mark is a ring with exactly one gap. It comes from
`nx_logo_mark()` in `website/inc/partials/icons.php` and the geometry is
load-bearing: `r=21` gives a circumference of about 132, so the
`stroke-dasharray="96 36"` is precisely one stroke and one gap. Change
the radius without changing the dasharray and you get two gaps, or three
— it stops being the logo.

## Rendering more sizes

```bash
rsvg-convert -w 256 -h 256 neoxify-avatar.svg -o avatar-256.png
```

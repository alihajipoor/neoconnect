Typefaces shipped with this site
===============================

All three are self-hosted. THE SITE MAKES NO THIRD-PARTY REQUESTS -- no
CDN, no fonts.googleapis.com, no fonts.gstatic.com. The audience is
largely on networks where a third-party request is slow at best and
blocked at worst, and a blocked font is a visibly broken page. Do not
"optimise" any of these back to a CDN.

They are the apps' own faces (the 2026-10 "pearl glass" redesign), so the
site and the app set type identically:

  inter-latin-v1.woff2        Inter, body text on English pages.
                              wght 400-700, Latin + Latin-1 + punctuation.
  inter-tight-latin-v1.woff2  Inter Tight, display type on English pages.
                              Pinned to 700 (the only weight used).
  vazirmatn-v2.woff2          Vazirmatn, EVERYTHING on Persian pages,
                              Latin words included, so a Persian page loads
                              exactly one font. wght 400-800. v2 added
                              the copyright, registered and trade mark
                              signs; v1 lacked the footer's copyright sign,
                              which then drew in Tahoma.

Each page preloads only what its first screen paints: an English page
the two Inter files, a Persian page Vazirmatn. An English page never
downloads Vazirmatn -- the "فا" in its language switch is drawn in a
system face.

Every one is licensed under the SIL Open Font License, Version 1.1, which
permits subsetting, self-hosting and redistribution. The licence for each
travels beside it and MUST STAY THERE:

  OFL-Inter.txt        Copyright 2016 The Inter Project Authors
  OFL-InterTight.txt   Copyright 2022 The Inter Project Authors
  OFL-Vazirmatn.txt    Copyright 2015 The Vazirmatn Project Authors

The copyright and licence records are also kept inside each woff2's name
table (name IDs 0, 13 and 14).


Rebuilding
----------

    node website/scripts/make-fonts.mjs --src <dir with the app's fonts>
    node website/scripts/make-fonts.mjs --src <dir> --check

The sources are the app's Inter-latin-wght.woff2, InterTight-latin-wght.woff2
and Vazirmatn-variable.woff2 (apps/desktop-windows/src/assets/ once the app
redesign is merged). --check reads every character in inc/lang and
inc/content and reports any the subsets do not cover; run it after any copy
change. A missing glyph does not break a page -- it falls through to a
system font and looks subtly wrong in one spot, which is the kind of fault
nobody notices for months.

If a font file changes, bump the -vN in its name in base.css AND in the
preload list in inc/partials/head.php: the files are cached for a year.

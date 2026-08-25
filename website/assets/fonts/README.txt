Typefaces shipped with this site
===============================

All four are self-hosted. THE SITE MAKES NO THIRD-PARTY REQUESTS -- no
CDN, no fonts.googleapis.com, no fonts.gstatic.com. The audience is
largely on networks where a third-party request is slow at best and
blocked at worst, and a blocked font is a visibly broken page. Do not
"optimise" any of these back to a CDN.

  vazirmatn-variable.woff2            Persian + Latin, wght 100-900
  bricolage-grotesque-variable.woff2  display face, opsz 12-96,
                                      wght 600-800, wdth 86-100
  instrument-sans-variable.woff2      body face, wght 400-700
  martian-mono-variable.woff2         mono labels and figures, wght 400-700

Every one is licensed under the SIL Open Font License, Version 1.1, which
permits self-hosting and redistribution. The licence for each travels
beside it and MUST STAY THERE:

  OFL-Vazirmatn.txt          Copyright 2015 The Vazirmatn Project Authors
  OFL-BricolageGrotesque.txt Copyright 2022 The Bricolage Grotesque Project Authors
  OFL-InstrumentSans.txt     Copyright 2022 The Instrument Sans Project Authors
  OFL-MartianMono.txt        Copyright 2021 The Martian Mono Project Authors

The copyright notice and licence are also embedded in each woff2's `name`
table (name IDs 0, 13 and 14), which is why the subsetting step keeps
those records.


Subsetting
----------

The three Latin faces are SUBSET to the 241 codepoints this site actually
renders -- measured by walking every rendered page, not guessed -- plus a
safety margin of full printable ASCII and Latin-1 Supplement so that a
name typed into a contact form is never drawn in a different face from
the text around it.

They carry NO Persian glyphs and are not meant to: html[lang="fa"] swaps
--display and --sans to Vazirmatn, and the mono stack keeps Martian first
only so Latin tokens and figures inside a Persian sentence stay in it.

Axes the stylesheet never varies are PINNED, which is most of the saving:
Instrument Sans dropped from 60 KB to 30 KB by pinning wdth, Martian Mono
from 37 KB to 16 KB. Bricolage keeps opsz and wdth because varying them
is the entire reason the design chose it.

After ANY copy change that might introduce a new character, run

    python3 scripts/make-fonts.py --check

It re-derives the inventory from the rendered pages and tells you whether
the shipped subset still covers it. Run it without --check to rebuild.

This matters because a missing glyph does not break the page -- it falls
through to the platform font and looks subtly wrong in one spot, which is
the kind of fault nobody notices for months.

The character set itself lives in scripts/fonts-unicodes.txt. Neither the
script nor that file ships in the deploy archive; scripts/ is excluded.

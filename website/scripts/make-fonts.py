#!/usr/bin/env python3
"""
Rebuild the three subset Latin webfonts in assets/fonts/.

You only need this if the site's copy grows a character the current subset
does not cover -- a new language of place name, a new currency symbol, a
typographic mark the design starts using. A missing glyph does not break
the page: it falls through to the platform font and looks subtly wrong in
one spot, which is exactly the kind of thing nobody notices for months.
So: after any copy change that might introduce new characters, run

    python3 scripts/make-fonts.py --check

which re-derives the character inventory from the rendered pages and tells
you whether the shipped subset still covers it. Run without --check to
actually rebuild.

Requires: fonttools, brotli   (pip install fonttools brotli)
The three source TTFs are NOT vendored -- they are downloaded from the
google/fonts repository, which is their canonical home.

---------------------------------------------------------------------------
WHY THESE ARE SELF-HOSTED AT ALL

The design was drawn with these three faces served from Google Fonts. That
is not an option here: a third-party request is slow at best and blocked at
worst on the networks this product exists for, and a blocked font is a
visibly broken page. So they are subset, vendored, and served from this
host, and the site makes zero third-party requests. Do not "optimise" that
back to a CDN.

All three are SIL OFL 1.1, which permits exactly this. The licences ship
beside the fonts and the copyright/licence records are kept inside each
woff2's name table -- see NAME_IDS below.
---------------------------------------------------------------------------
"""

import argparse
import os
import re
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
FONT_DIR = os.path.join(SITE, 'assets', 'fonts')
UNICODES = os.path.join(HERE, 'fonts-unicodes.txt')

GF = 'https://raw.githubusercontent.com/google/fonts/main/ofl'

# source URL, output woff2, instancer args, licence output name
FONTS = [
    ('bricolagegrotesque/BricolageGrotesque%5Bopsz,wdth,wght%5D.ttf',
     'bricolage-grotesque-variable.woff2',
     ['wght=600:800', 'wdth=86:100'],
     'OFL-BricolageGrotesque.txt', 'bricolagegrotesque'),

    ('instrumentsans/InstrumentSans%5Bwdth,wght%5D.ttf',
     'instrument-sans-variable.woff2',
     ['wdth=100'],
     'OFL-InstrumentSans.txt', 'instrumentsans'),

    ('martianmono/MartianMono%5Bwdth,wght%5D.ttf',
     'martian-mono-variable.woff2',
     ['wdth=100', 'wght=400:700'],
     'OFL-MartianMono.txt', 'martianmono'),
]

# Features the stylesheet depends on. `tnum` is NOT optional: prices, plan
# amounts and the instrument readouts all use tabular figures, and dropping
# it makes numbers jitter as they change.
FEATURES = 'ccmp,locl,mark,mkmk,kern,liga,clig,calt,tnum,lnum,frac,ordn,case'

# 0 copyright, 13 licence, 14 licence URL -- required by the OFL and dropped
# by pyftsubset unless asked for. The rest are identity records.
NAME_IDS = '0,1,2,3,4,5,6,13,14'

PAGES = ['', 'features', 'pricing', 'faq', 'download',
         'contact', 'reseller', 'privacy', 'delete-account']


def rendered_characters():
    """Every non-Persian character the site actually renders."""
    found = set()
    targets = []
    for p in PAGES:
        targets.append(os.path.join(SITE, p, 'index.php') if p else os.path.join(SITE, 'index.php'))
        targets.append(os.path.join(SITE, 'fa', p, 'index.php') if p else os.path.join(SITE, 'fa', 'index.php'))
    targets.append(os.path.join(SITE, '404.php'))

    for t in targets:
        if not os.path.isfile(t):
            continue
        out = subprocess.run(['php', '-d', 'display_errors=0', t],
                             capture_output=True, cwd=SITE)
        html = out.stdout.decode('utf-8', 'replace')
        html = re.sub(r'<(script|style)[^>]*>.*?</\1>', ' ', html, flags=re.S | re.I)
        html = re.sub(r'<[^>]+>', ' ', html)
        html = html.replace('&mdash;', '—').replace('&middot;', '·')
        html = re.sub(r'&[a-zA-Z#0-9]+;', ' ', html)
        found |= set(html)

    def persian(ch):
        o = ord(ch)
        return (0x0600 <= o <= 0x06FF or 0x0750 <= o <= 0x077F
                or 0xFB50 <= o <= 0xFDFF or 0xFE70 <= o <= 0xFEFF
                or o in (0x200C, 0x200E, 0x200F))

    # Emoji are never drawn by these faces; flags are inline SVG now.
    return {c for c in found
            if not persian(c) and 0x20 <= ord(c) < 0x1F000}


def shipped_codepoints():
    raw = open(UNICODES, encoding='utf-8').read()
    return {int(x[2:], 16) for x in raw.split(',') if x.strip()}


def check():
    have = shipped_codepoints()
    need = {ord(c) for c in rendered_characters()}
    missing = sorted(need - have)
    print('shipped subset covers %d codepoints' % len(have))
    print('pages currently render  %d distinct non-Persian characters' % len(need))
    if not missing:
        print('\nOK -- every rendered character is covered.')
        return 0
    print('\nMISSING from the shipped subset (%d):' % len(missing))
    for cp in missing:
        print('   U+%04X  %r' % (cp, chr(cp)))
    print('\nAdd them to scripts/fonts-unicodes.txt and re-run without --check.')
    return 1


def build():
    tmp = os.path.join(HERE, '_fontbuild')
    os.makedirs(tmp, exist_ok=True)
    total = 0

    for src, out, inst, lic, slug in FONTS:
        ttf = os.path.join(tmp, out.replace('.woff2', '.ttf'))
        print('downloading %s ...' % src.split('/')[-1])
        urllib.request.urlretrieve(GF + '/' + src, ttf)
        urllib.request.urlretrieve(GF + '/' + slug + '/OFL.txt',
                                   os.path.join(FONT_DIR, lic))

        inst_ttf = ttf.replace('.ttf', '-inst.ttf')
        subprocess.run([sys.executable, '-m', 'fontTools.varLib.instancer',
                        ttf, *inst, '-o', inst_ttf], check=True,
                       stdout=subprocess.DEVNULL)

        dst = os.path.join(FONT_DIR, out)
        subprocess.run([sys.executable, '-m', 'fontTools.subset', inst_ttf,
                        '--unicodes-file=' + UNICODES,
                        '--layout-features=' + FEATURES,
                        '--name-IDs=' + NAME_IDS,
                        '--flavor=woff2',
                        '--drop-tables+=DSIG',
                        '--no-hinting',
                        '--output-file=' + dst], check=True,
                       stdout=subprocess.DEVNULL)

        size = os.path.getsize(dst)
        total += size
        print('  %-42s %7d B' % (out, size))

    print('  %-42s %7d B  (%.1f KB)' % ('-- total --', total, total / 1024.0))
    print('\nSource TTFs left in %s -- delete when done.' % tmp)
    return 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--check', action='store_true',
                    help='report whether the shipped subset still covers the site')
    args = ap.parse_args()
    sys.exit(check() if args.check else build())

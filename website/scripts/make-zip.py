#!/usr/bin/env python3
"""
Fallback archive builder for make-zip.sh, used when `zip` is not installed.

WHY THIS EXISTS
---------------
`zip` is not present on a stock Windows dev box, and the obvious substitute
there — PowerShell's Compress-Archive — writes entry names with BACKSLASH
separators. That archive unpacks correctly on Windows and produces a single
flat pile of files called "inc\\bootstrap.php" on the Linux host the site
actually runs on. It has bitten this project before, so it is not an option.

Python's zipfile always writes forward slashes (the ZIP spec requires them),
so this produces a byte-for-byte equivalent layout to `zip -r`.

The exclusion list is kept identical to make-zip.sh's. If you change one,
change the other in the same sitting.

Usage (make-zip.sh calls this automatically):
    python3 scripts/make-zip.py <site_dir> <archive_path>
"""

import os
import sys
import zipfile

# Mirrors the -x patterns in make-zip.sh, matched against the archive-relative
# POSIX path of each file.
#
#   build/        the output directory itself
#   README.md     deploy instructions, not part of the site
#   make-zip.sh   the build script
#   scripts/      dev tooling: the pre-deploy check, the router, this file
#   nginx-*.example
#                 the server config. Nothing rewrites it, so inside the
#                 docroot it is served as PLAIN TEXT -- handing over the CSP,
#                 the fastcgi socket path and the document root to anyone who
#                 asks. It belongs in the server's config directory.
#   .gitignore    repository bookkeeping
#   *.zip         a previous archive left in the docroot
#   data/secret.php, data/ratelimit.php, data/submissions-*.php
#                 the CSRF secret, rate-limit state, and real submitted data.
#                 data/ AND data/.htaccess are still included, so a fresh
#                 install is writable and protected from the first request --
#                 but nobody's actual messages ever travel in the zip.


def excluded(rel):
    if rel == 'README.md' or rel == 'make-zip.sh' or rel == '.gitignore':
        return True
    if rel.endswith('/.gitignore'):
        return True
    if rel.startswith('build/') or rel.startswith('scripts/'):
        return True
    if rel == 'nginx-website.conf.example':
        return True
    if rel.endswith('.zip'):
        return True
    if rel in ('data/secret.php', 'data/ratelimit.php'):
        return True
    if rel.startswith('data/submissions-'):
        return True
    # Editor and OS litter that has no business on a webserver.
    if os.path.basename(rel) in ('.DS_Store', 'Thumbs.db', 'desktop.ini'):
        return True
    return False


def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2

    site_dir, archive = sys.argv[1], sys.argv[2]
    os.makedirs(os.path.dirname(archive), exist_ok=True)
    if os.path.exists(archive):
        os.remove(archive)

    count = 0
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, dirs, files in os.walk(site_dir):
            dirs.sort()
            # Never descend into the output directory or the VCS metadata.
            dirs[:] = [d for d in dirs if d not in ('build', '.git')]
            for name in sorted(files):
                full = os.path.join(root, name)
                rel = os.path.relpath(full, site_dir).replace(os.sep, '/')
                if excluded(rel):
                    continue
                # arcname is already POSIX-separated; zipfile keeps it that way.
                z.write(full, rel)
                count += 1

        # data/ must exist on a fresh install even though every file we would
        # ship from it is excluded, so the first submission has somewhere to
        # go. Its .htaccess is a real file and is included above; this only
        # adds the directory entry if the walk produced nothing else for it.
        names = z.namelist()
        if not any(n.startswith('data/') for n in names):
            z.writestr('data/', '')

    print('Built: %s' % archive)
    print('%d files.' % count)
    return 0


if __name__ == '__main__':
    sys.exit(main())

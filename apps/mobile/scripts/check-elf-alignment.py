#!/usr/bin/env python3
"""Fails if any 64-bit native library in an APK/AAB is not 16 KB aligned.

Google Play requires every 64-bit shared library to have its ELF load
segments aligned to at least 16384 bytes. This is not a soft requirement
that degrades performance: a device using 16 KB pages cannot map a
4 KB-aligned library at all, so the app dies at startup, on exactly the
newer hardware whose owners are least likely to blame the app rather
than the phone.

Why this exists as a build step rather than a note in a runbook: the
0.2.10 bundle failed it, and nothing in the build said so. Play caught
it at the last screen before publishing, after the version had been
tagged, built, signed and uploaded. The toolchain settings that produce
alignment are spread across three producers -- the NDK for cargo, the
NDK for gomobile, and a prebuilt third-party AAR that answers to
neither -- so "we set the NDK version" is not evidence about the
artifact. Only the artifact is.

Usage:
    python scripts/check-elf-alignment.py Neoxify-0.2.11.aab [more...]
"""

import struct
import sys
import zipfile

PT_LOAD = 1
REQUIRED_ALIGN = 16384

# Only 64-bit ABIs are judged. No 32-bit Android device uses 16 KB pages,
# and the published libraries reflect that -- the WireGuard AAR that
# satisfies this rule still ships its armeabi-v7a and x86 libraries at
# 4096. Failing those would be failing correct output.
SIXTY_FOUR_BIT_ABIS = {"arm64-v8a", "x86_64"}


def load_segment_alignments(data: bytes) -> list[int]:
    """Every PT_LOAD segment's p_align, for either ELF class."""
    if data[:4] != b"\x7fELF":
        return []
    is_64 = data[4] == 2
    endian = "<" if data[5] == 1 else ">"

    if is_64:
        (e_phoff,) = struct.unpack_from(endian + "Q", data, 0x20)
        e_phentsize, e_phnum = struct.unpack_from(endian + "HH", data, 0x36)
        align_offset, align_fmt = 0x30, "Q"
    else:
        (e_phoff,) = struct.unpack_from(endian + "I", data, 0x1C)
        e_phentsize, e_phnum = struct.unpack_from(endian + "HH", data, 0x2A)
        align_offset, align_fmt = 0x1C, "I"

    alignments = []
    for i in range(e_phnum):
        header = e_phoff + i * e_phentsize
        (p_type,) = struct.unpack_from(endian + "I", data, header)
        if p_type == PT_LOAD:
            (p_align,) = struct.unpack_from(endian + align_fmt, data, header + align_offset)
            alignments.append(p_align)
    return alignments


def abi_of(entry: str) -> str:
    """The ABI directory holding this library.

    Two layouts, because two kinds of archive get checked: an APK or AAB
    stores libraries under lib/<abi>/, a raw .aar under jni/<abi>/.
    Missing the second is not a harmless gap -- every library would fall
    back to unknown, be treated as 32-bit and exempt, and the archive
    would report clean without one library having been judged.
    """
    parts = entry.split("/")
    for anchor in ("lib", "jni"):
        if anchor in parts:
            i = parts.index(anchor) + 1
            if i < len(parts) - 1:
                return parts[i]
    return "?"


def check(path: str) -> tuple[int, int]:
    """Returns (libraries judged, libraries failed) for one archive."""
    judged = failed = 0
    print(f"\n{path}")
    print(f"  {'library':<40} {'abi':<12} {'align':>8}  verdict")
    print(f"  {'-' * 74}")

    with zipfile.ZipFile(path) as archive:
        entries = sorted(n for n in archive.namelist() if n.endswith(".so"))
        for entry in entries:
            abi = abi_of(entry)
            alignments = load_segment_alignments(archive.read(entry))
            name = entry.split("/")[-1]
            if not alignments:
                print(f"  {name:<40} {abi:<12} {'-':>8}  not an ELF, skipped")
                continue
            worst = min(alignments)
            if abi not in SIXTY_FOUR_BIT_ABIS:
                verdict = "n/a (32-bit)"
            else:
                judged += 1
                if worst >= REQUIRED_ALIGN:
                    verdict = "OK"
                else:
                    verdict = f"TOO SMALL, needs {REQUIRED_ALIGN}"
                    failed += 1
                    print(f"::error::{name} ({abi}) is {worst}-byte aligned; "
                          f"Play requires {REQUIRED_ALIGN} for 64-bit libraries")
            print(f"  {name:<40} {abi:<12} {worst:>8}  {verdict}")

    return judged, failed


def main(paths: list[str]) -> int:
    if not paths:
        print("usage: check-elf-alignment.py <apk-or-aab> [...]", file=sys.stderr)
        return 2

    total_judged = total_failed = 0
    for path in paths:
        judged, failed = check(path)
        total_judged += judged
        total_failed += failed

    # stdout is block-buffered when it is a log rather than a terminal,
    # while stderr is not, so without this the verdict below prints
    # above the table that justifies it.
    print()
    sys.stdout.flush()

    # Zero libraries judged means this check learned nothing, and saying
    # nothing is not the same as saying yes. Both of this repo's earlier
    # build guards were waved through at some point by a check that had
    # quietly stopped looking at anything, so the empty case is a failure
    # here rather than a pass.
    if total_judged == 0:
        print("::error::No 64-bit native libraries were found to check. This check "
              "is broken or the archive layout changed -- it is not a clean build.",
              file=sys.stderr)
        return 1

    if total_failed:
        print(f"{total_failed} of {total_judged} 64-bit libraries are below "
              f"{REQUIRED_ALIGN}-byte alignment.", file=sys.stderr)
        print("Play will refuse the bundle, and affected devices cannot load the "
              "library at all. Check the NDK version in the workflow (r28+) and "
              "any prebuilt .so arriving through a dependency.", file=sys.stderr)
        return 1

    print(f"All {total_judged} 64-bit libraries are aligned to at least {REQUIRED_ALIGN} bytes.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

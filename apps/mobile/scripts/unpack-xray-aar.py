"""Splits the gomobile .aar into the two pieces Gradle will accept.

An Android library module cannot depend on a local .aar. Gradle refuses
outright, and it is right to: the nested archive's classes and resources
would not be packaged into the library's own .aar, so the result would
build and then fail at runtime with a missing class. The pieces are both
supported on their own -- a plain .jar as a file dependency, and the
native library through jniLibs, which a library module does package.
"""

import pathlib
import sys
import zipfile

ABI = "arm64-v8a"


def main() -> int:
    aar, libs = sys.argv[1], pathlib.Path(sys.argv[2])
    with zipfile.ZipFile(aar) as archive:
        (libs / "jni" / ABI).mkdir(parents=True, exist_ok=True)
        (libs / "xray-classes.jar").write_bytes(archive.read("classes.jar"))
        (libs / "jni" / ABI / "libgojni.so").write_bytes(
            archive.read(f"jni/{ABI}/libgojni.so")
        )
    print(f"unpacked xray-classes.jar and jni/{ABI}/libgojni.so")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

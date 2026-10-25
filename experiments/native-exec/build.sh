#!/usr/bin/env bash
#
# Cross-compile hello.c for ARMv7 Linux and package it as an unsigned .tpk.
#
# The .tpk is handed to the tizen-homebrew service through the usual install path,
# which re-signs it with the user's stored Partner certificate before vd_appinstall
# sees it — so this script does no signing itself.
#
# Prefers musl static linking (produces a fully portable binary); falls back to
# gnueabihf glibc static if musl is unavailable.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

mkdir -p release build/bin

pick_cc() {
    for candidate in arm-linux-musleabihf-gcc arm-linux-musleabi-gcc arm-linux-gnueabihf-gcc; do
        if command -v "$candidate" >/dev/null 2>&1; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

CC="$(pick_cc)" || {
    echo "No ARMv7 cross-compiler on PATH." >&2
    echo "On Debian/Ubuntu:" >&2
    echo "  sudo apt-get install -y gcc-arm-linux-gnueabihf  # glibc toolchain" >&2
    echo "Or install one of the musl variants (musl.cc, Alpine, Buildroot)." >&2
    exit 1
}

echo "cross-compiler: $CC"

# -Os -s makes it tiny; -static means the TV's libc version does not matter.
# -fPIE/-pie are omitted on purpose: the exec verifier is what blocks us or not,
# and PIE adds nothing to that answer; make the binary one shape, one size.
"$CC" -static -Os -s -o build/bin/hello src/hello.c

file build/bin/hello

# A sanity check: refuse to continue if we accidentally produced a host binary.
if ! file build/bin/hello | grep -q 'ARM'; then
    echo "The output is not an ARM binary; something went wrong." >&2
    exit 2
fi

# The tpk is a plain zip of the manifest and the bin/ directory. Signatures are
# added by tizen-homebrew's installer, which drops any already in the archive.
cp tizen-manifest.xml build/
version="$(grep -oE 'version="[^"]+"' tizen-manifest.xml | head -1 | cut -d'"' -f2)"
pkg="release/org.homebrew.nativeexec-${version}.tpk"

(cd build && zip -q -X -r "../$pkg" tizen-manifest.xml bin/)

echo
echo "built: $pkg"
echo
unzip -l "$pkg"
echo
echo "install it by uploading through tizen-homebrew the usual way;"
echo "the installer re-signs with your stored Partner certificate."

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

build_with_zig() {
    zig cc -target arm-linux-musleabihf -static -Os -s -o build/bin/hello src/hello.c
}

build_with_gcc() {
    local candidate
    for candidate in arm-linux-musleabihf-gcc arm-linux-musleabi-gcc arm-linux-gnueabihf-gcc; do
        if command -v "$candidate" >/dev/null 2>&1; then
            echo "cross-compiler: $candidate"
            "$candidate" -static -Os -s -o build/bin/hello src/hello.c
            return 0
        fi
    done
    return 1
}

# Prefer zig — one binary, cross-compiles to any musl target, no setup. Fall back to a
# traditional cross-gcc if that is what the host happens to have.
if command -v zig >/dev/null 2>&1; then
    echo "cross-compiler: zig cc (arm-linux-musleabihf)"
    build_with_zig
elif ! build_with_gcc; then
    echo "No ARMv7 cross-compiler on PATH." >&2
    echo "  curl -fsSL https://ziglang.org/download/0.13.0/zig-linux-x86_64-0.13.0.tar.xz | tar -xJ" >&2
    echo "  export PATH=\"$PWD/zig-linux-x86_64-0.13.0:\$PATH\"" >&2
    echo "or" >&2
    echo "  sudo apt-get install -y gcc-arm-linux-gnueabihf" >&2
    exit 1
fi

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

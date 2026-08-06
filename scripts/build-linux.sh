#!/usr/bin/env bash
# Builds the Linux Tauri bundle (.deb + .AppImage) for PDF Manager.
#
# Must keep LF line endings (enforced via .gitattributes: *.sh text eol=lf) —
# a CRLF-mangled shebang here fails as "/usr/bin/env: 'bash\r': No such file
# or directory" when Git for Windows checks it out with core.autocrlf=true.
#
# Meant to run inside WSL2 (invoked automatically by
# scripts\build-windows-exe.ps1 -Linux), but works in any Debian/Ubuntu-based
# Linux the same way if run directly.
#
# Usage:
#   ./scripts/build-linux.sh [git-ref]
#
# git-ref defaults to the current HEAD of the repo this script lives in.
# The build itself happens in a separate clone on the native Linux filesystem
# ($PDF_MANAGER_LINUX_BUILD_DIR, default ~/pdf-manager-linux-build) — building
# directly on the /mnt/c NTFS-via-9p bridge is much slower and can trip up
# Cargo's file locking. Finished .deb/.AppImage files are copied back next to
# this script (dist-linux/), so they show up under the Windows-visible repo
# folder too.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="${PDF_MANAGER_LINUX_BUILD_DIR:-$HOME/pdf-manager-linux-build}"
OUT_DIR="$SRC_REPO/dist-linux"
GIT_REF="${1:-$(git -C "$SRC_REPO" rev-parse HEAD)}"

step() { printf '\n==> %s\n' "$1"; }
ok()   { printf 'OK  %s\n' "$1"; }
fail() { printf 'ERR %s\n' "$1" >&2; }

step "System dependencies (apt)"
REQUIRED_PKGS=(
  build-essential curl wget file git
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
  librsvg2-dev patchelf libssl-dev
)
MISSING=()
for pkg in "${REQUIRED_PKGS[@]}"; do
  dpkg -s "$pkg" >/dev/null 2>&1 || MISSING+=("$pkg")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "Installing: ${MISSING[*]}"
  sudo apt-get update
  sudo apt-get install -y "${MISSING[@]}"
  ok "apt dependencies installed"
else
  ok "apt dependencies already present"
fi

command -v rustc >/dev/null 2>&1 || { fail "rustc not found. Install: curl https://sh.rustup.rs -sSf | sh -s -- -y"; exit 1; }
command -v cargo >/dev/null 2>&1 || { fail "cargo not found (comes with rustup)"; exit 1; }
command -v node   >/dev/null 2>&1 || { fail "node not found. Install Node 20+ inside WSL2 (e.g. via nvm)"; exit 1; }
command -v npm    >/dev/null 2>&1 || { fail "npm not found (comes with node)"; exit 1; }
ok "rustc: $(rustc --version)"
ok "node:  $(node --version)"

step "Sync source into native Linux filesystem ($BUILD_DIR)"
if [[ ! -d "$BUILD_DIR/.git" ]]; then
  git clone "$SRC_REPO" "$BUILD_DIR"
else
  git -C "$BUILD_DIR" remote set-url origin "$SRC_REPO"
fi
git -C "$BUILD_DIR" fetch origin
git -C "$BUILD_DIR" checkout -f "$GIT_REF"
ok "Building $(git -C "$BUILD_DIR" rev-parse --short HEAD) — $(git -C "$BUILD_DIR" log -1 --pretty=%s)"

cd "$BUILD_DIR"

step "npm ci"
npm ci

step "Tauri build (deb + AppImage)"
echo "First build can take 10-20+ minutes (crates.io + AppImage tooling download)."
npx tauri build

step "Collect artifacts"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
DEB_DIR="$BUILD_DIR/src-tauri/target/release/bundle/deb"
APPIMAGE_DIR="$BUILD_DIR/src-tauri/target/release/bundle/appimage"
found=0
if compgen -G "$DEB_DIR/*.deb" > /dev/null; then
  cp -f "$DEB_DIR"/*.deb "$OUT_DIR"/
  found=1
fi
if compgen -G "$APPIMAGE_DIR/*.AppImage" > /dev/null; then
  cp -f "$APPIMAGE_DIR"/*.AppImage "$OUT_DIR"/
  found=1
fi

if [[ "$found" -eq 1 ]]; then
  ok "Artifacts copied to: $OUT_DIR"
  ls -la "$OUT_DIR"
else
  fail "No .deb/.AppImage found in bundle output — check the build log above."
  exit 1
fi

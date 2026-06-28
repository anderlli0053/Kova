#!/usr/bin/env bash
# Regenerate all platform icons from the two icon source SVGs.
#
# icon-source.svg       — edge-to-edge artwork (Windows, Linux, Android, iOS)
# icon-source-macos.svg — same artwork with Apple HIG 10% safe-area padding (macOS dock)
#
# Usage: bash scripts/generate-icons.sh  (run from repo root)

set -euo pipefail

ICONS_DIR="src-tauri/icons"
TAURI="./node_modules/.bin/tauri"
TMPDIR_MACOS="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_MACOS"' EXIT

echo "→ Generating all platform icons from edge-to-edge source..."
"$TAURI" icon "$ICONS_DIR/icon-source.svg" -o "$ICONS_DIR"

echo "→ Generating macOS icon.icns from Apple HIG padded source..."
"$TAURI" icon "$ICONS_DIR/icon-source-macos.svg" -o "$TMPDIR_MACOS"
cp "$TMPDIR_MACOS/icon.icns" "$ICONS_DIR/icon.icns"

echo "✓ Done. All icons regenerated."
echo "  Windows/Linux/Android/iOS: edge-to-edge ($ICONS_DIR/icon-source.svg)"
echo "  macOS dock (icon.icns):    10% padding  ($ICONS_DIR/icon-source-macos.svg)"

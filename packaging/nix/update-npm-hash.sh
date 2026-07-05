#!/usr/bin/env bash
# Recompute the flake's npmDepsHash from package-lock.json and write it back.
# Run after any dependency change. Needs Nix.
set -euo pipefail
cd "$(dirname "$0")/../.."
# --inputs-from . pins prefetch-npm-deps to the flake's own nixpkgs.
hash=$(nix run --inputs-from . nixpkgs#prefetch-npm-deps -- package-lock.json)
# Fail loud if the line moved — a silent no-op would ship a stale hash.
grep -q 'npmDepsHash = "' flake.nix || { echo "npmDepsHash line not found in flake.nix" >&2; exit 1; }
# perl -pi is portable across macOS/Linux (BSD/GNU sed differ on -i).
perl -pi -e "s|npmDepsHash = \".*\"|npmDepsHash = \"$hash\"|" flake.nix
echo "npmDepsHash -> $hash"

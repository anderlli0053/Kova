#!/usr/bin/env node
// Bumps Kova's version across every file that hand-maintains it, so a release
// never drifts out of sync. See the four locations below — if you add a new
// place that hardcodes the version, add it here too.
//
// Usage:
//   npm run bump-version -- 0.4.11
//   node scripts/bump-version.mjs 0.4.11

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const newVersion = process.argv[2];
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?(\+[0-9A-Za-z-.]+)?$/;

if (!newVersion || !SEMVER_RE.test(newVersion)) {
  console.error('Usage: npm run bump-version -- <version>');
  console.error('  e.g. npm run bump-version -- 0.4.11');
  process.exit(1);
}

// Each entry: file path (relative to repo root), a regex whose first capture
// group is the version string, and a function producing the replacement line.
const TARGETS = [
  {
    file: 'package.json',
    pattern: /^(\s*"version":\s*")[^"]+(")/m,
  },
  {
    file: 'src-tauri/tauri.conf.json',
    pattern: /^(\s*"version":\s*")[^"]+(")/m,
  },
  {
    file: 'src-tauri/Cargo.toml',
    pattern: /^(version\s*=\s*")[^"]+(")/m,
  },
  {
    file: 'src/version.ts',
    pattern: /^(export const APP_VERSION = ')[^']+(';)/m,
  },
];

let changedCount = 0;

for (const { file, pattern } of TARGETS) {
  const abs = path.join(root, file);
  const original = readFileSync(abs, 'utf8');

  if (!pattern.test(original)) {
    console.error(`✗ ${file}: pattern not found — version string may have moved. Update scripts/bump-version.mjs.`);
    process.exit(1);
  }

  const updated = original.replace(pattern, (_match, before, after) => `${before}${newVersion}${after}`);
  if (updated === original) {
    console.log(`= ${file}: already at ${newVersion}`);
  } else {
    writeFileSync(abs, updated);
    console.log(`✓ ${file}: bumped to ${newVersion}`);
    changedCount++;
  }
}

// Refresh Cargo.lock's own "kova" entry so it isn't left stale alongside the
// Cargo.toml bump. Best-effort: skip quietly if cargo isn't on PATH (e.g. a
// frontend-only contributor running this script).
try {
  execFileSync('cargo', ['check', '--quiet', '--manifest-path', 'src-tauri/Cargo.toml'], {
    cwd: root,
    stdio: 'inherit',
  });
  console.log('✓ src-tauri/Cargo.lock: refreshed via `cargo check`');
} catch (err) {
  console.warn(`⚠ Skipped \`cargo check\` (${err.code === 'ENOENT' ? 'cargo not found on PATH' : 'see output above'}) — run it manually before committing so Cargo.lock matches.`);
}

console.log(changedCount > 0 ? `\nDone — ${newVersion} applied across ${TARGETS.length} files.` : '\nAll files already at this version.');

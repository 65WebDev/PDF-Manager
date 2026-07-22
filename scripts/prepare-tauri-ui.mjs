#!/usr/bin/env node
/**
 * Prepares the static UI folder consumed by the Tauri shell:
 * 1) builds PDF_manager_offline.html (all libs inlined)
 * 2) copies it to tauri-ui/index.html
 *
 * Not part of the GitHub Release pipeline yet — local / manual Windows builds only.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const offlineHtml = join(root, 'PDF_manager_offline.html');
const uiDir = join(root, 'tauri-ui');
const uiIndex = join(uiDir, 'index.html');

console.log('Building offline HTML for Tauri…');
const build = spawnSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'build:offline'],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (!existsSync(offlineHtml)) {
  console.error('Expected offline build at', offlineHtml);
  process.exit(1);
}

mkdirSync(uiDir, { recursive: true });
copyFileSync(offlineHtml, uiIndex);
console.log('Wrote', uiIndex);

#!/usr/bin/env node
/**
 * Keeps README.md's "Embedded libraries" bullet lists (English + Russian)
 * in sync with PDF_MANAGER_LIBRARIES in PDF_manager_online.html - the same
 * array the in-app "About" dialog reads from, so README never has to be
 * hand-edited when a dependency version bumps.
 *
 * Run standalone to update README.md locally; the release workflow runs
 * this on every build and commits README.md back to main if it changed
 * (README.md is not in that workflow's trigger paths, so this can't loop).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const HTML_PATH = join(root, 'PDF_manager_online.html');
const README_PATH = join(root, 'README.md');

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : String(v);
}

function readLibraries() {
  const html = readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/const PDF_MANAGER_LIBRARIES = (\[[\s\S]*?\]);/);
  if (!m) {
    throw new Error('Could not find PDF_MANAGER_LIBRARIES in PDF_manager_online.html');
  }
  // The array is a plain JS literal (name/version string pairs) - evaluate
  // it directly rather than pull in a parser dependency for this.
  const list = new Function(`return ${m[1]};`)();
  if (!Array.isArray(list) || !list.length) {
    throw new Error('PDF_MANAGER_LIBRARIES parsed empty');
  }
  return list;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrites every "- **NAME** — description" bullet (English and Russian
 * sections share this exact prefix shape) into "- **NAME** vX.Y.Z —
 * description", replacing any version already there. A library with no
 * matching bullet is skipped with a warning rather than failing the build -
 * README's library list is prose, not guaranteed to list every entry.
 */
function syncReadme(libraries) {
  let readme = readFileSync(README_PATH, 'utf8');
  let changed = false;
  for (const [name, version] of libraries) {
    const pattern = new RegExp(`(^- \\*\\*${escapeRegExp(name)}\\*\\*)(?: v[^\\s—]+)? —`, 'gm');
    if (!pattern.test(readme)) {
      console.warn(`sync-readme-libraries: no README bullet found for "${name}" - skipped`);
      continue;
    }
    const next = readme.replace(pattern, (_full, prefix) => `${prefix} v${version} —`);
    if (next !== readme) {
      readme = next;
      changed = true;
    }
  }
  return { readme, changed };
}

function commitToMain() {
  spawnSync('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: root });
  spawnSync(
    'git',
    ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'],
    { cwd: root },
  );
  spawnSync('git', ['add', 'README.md'], { cwd: root });
  const staged = spawnSync('git', ['diff', '--staged', '--quiet'], { cwd: root });
  if (staged.status === 0) {
    console.log('README.md unchanged - skip commit');
    return;
  }
  const commit = spawnSync('git', ['commit', '-m', 'docs: sync embedded library versions in README'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (commit.status !== 0) process.exit(commit.status ?? 1);
  const branch = env('GITHUB_REF_NAME', 'main') || 'main';
  const push = spawnSync('git', ['push', 'origin', `HEAD:${branch}`], { cwd: root, stdio: 'inherit' });
  if (push.status !== 0) {
    console.warn('Push of README.md failed (non-fatal for release artifacts).');
  }
}

function main() {
  const libraries = readLibraries();
  const { readme, changed } = syncReadme(libraries);
  if (!changed) {
    console.log('README.md library versions already up to date');
  } else {
    writeFileSync(README_PATH, readme, 'utf8');
    console.log('README.md library versions updated');
  }
  if (env('SKIP_COMMIT') === '1') return;
  if (changed) commitToMain();
}

main();

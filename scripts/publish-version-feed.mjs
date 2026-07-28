#!/usr/bin/env node
/**
 * Writes and publishes the About-dialog version feed.
 *
 * Inputs (env):
 *   BUILD          e.g. build-89
 *   NUMBER         e.g. 89
 *   DATE           ISO date (optional)
 *   COMMIT / SHORT_COMMIT / DOWNLOAD_URL / OFFLINE_DOWNLOAD_URL (optional)
 *   WINDOWS_VERSION / WINDOWS_DOWNLOAD_URL (optional; merged into existing feed)
 *   SKIP_GH=1      write files only, do not upload/commit
 *   SKIP_COMMIT=1  upload release asset but do not commit to main
 *
 * Outputs in repo root:
 *   version.json
 *   version-feed.js  (loadable via <script>, no CORS issues)
 *
 * Also uploads version-feed.js to a floating GitHub Release tag `version-feed`
 * (not marked latest) so installed clients can poll a stable URL.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const FEED_TAG = 'version-feed';
const FEED_JS = join(root, 'version-feed.js');
const FEED_JSON = join(root, 'version.json');

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : String(v);
}

function runGh(args, opts = {}) {
  return spawnSync('gh', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  });
}

function readExistingFeed() {
  if (!existsSync(FEED_JS)) return {};
  try {
    const text = readFileSync(FEED_JS, 'utf8');
    const m = text.match(/window\.__PDF_MANAGER_VERSION_FEED__\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!m) return {};
    return JSON.parse(m[1]);
  } catch {
    return {};
  }
}

function latestWindowsFromGh() {
  const r = runGh([
    'release',
    'list',
    '--limit',
    '30',
    '--json',
    'tagName,url',
  ]);
  if (r.status !== 0) return null;
  try {
    const list = JSON.parse(r.stdout || '[]');
    for (const item of list) {
      const tag = String(item.tagName || '');
      const m = /^windows-v(.+)$/i.exec(tag);
      if (m) {
        return {
          windowsVersion: m[1],
          windowsDownloadUrl:
            item.url ||
            `https://github.com/5451165-bot/PDF-Manager/releases/tag/${tag}`,
        };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function buildFeed() {
  const prev = readExistingFeed();
  const winGh = latestWindowsFromGh() || {};

  const build = env('BUILD', prev.build || '');
  const numberRaw = env('NUMBER', prev.number != null ? String(prev.number) : '');
  const number = Number(numberRaw);
  const date = env('DATE', prev.date || new Date().toISOString());
  const commit = env('COMMIT', prev.commit || '');
  const shortCommit = env('SHORT_COMMIT', prev.shortCommit || (commit ? commit.slice(0, 7) : ''));
  const downloadUrl = env(
    'DOWNLOAD_URL',
    prev.downloadUrl ||
      'https://github.com/5451165-bot/PDF-Manager/releases/latest/download/PDF_manager_online.html',
  );
  const offlineDownloadUrl = env(
    'OFFLINE_DOWNLOAD_URL',
    prev.offlineDownloadUrl ||
      'https://github.com/5451165-bot/PDF-Manager/releases/latest/download/PDF_manager_offline.html',
  );

  const windowsVersion = env(
    'WINDOWS_VERSION',
    winGh.windowsVersion || prev.windowsVersion || '',
  );
  const windowsDownloadUrl = env(
    'WINDOWS_DOWNLOAD_URL',
    winGh.windowsDownloadUrl || prev.windowsDownloadUrl || '',
  );

  const feed = {
    build: build || prev.build || '',
    number: Number.isFinite(number) ? number : Number(prev.number) || 0,
    commit,
    shortCommit,
    date,
    downloadUrl,
    offlineDownloadUrl,
    windowsVersion,
    windowsDownloadUrl,
    updatedAt: new Date().toISOString(),
  };
  return feed;
}

function writeFeedFiles(feed) {
  writeFileSync(FEED_JSON, JSON.stringify(feed, null, 2) + '\n', 'utf8');
  const js =
    '/* Auto-generated version feed for the About dialog. Do not edit by hand. */\n' +
    'window.__PDF_MANAGER_VERSION_FEED__ = ' +
    JSON.stringify(feed, null, 2) +
    ';\n';
  writeFileSync(FEED_JS, js, 'utf8');
  console.log('Wrote', FEED_JSON);
  console.log('Wrote', FEED_JS);
}

function publishToFloatingRelease() {
  const view = runGh(['release', 'view', FEED_TAG], { stdio: 'ignore' });
  if (view.status !== 0) {
    console.log(`Creating floating release ${FEED_TAG}…`);
    const created = runGh(
      [
        'release',
        'create',
        FEED_TAG,
        FEED_JS,
        FEED_JSON,
        '--title',
        'Version feed',
        '--notes',
        'Stable URL for About-dialog update checks. Not a product build.',
        '--latest=false',
      ],
      { stdio: 'inherit' },
    );
    if (created.status !== 0) process.exit(created.status ?? 1);
    return;
  }
  console.log(`Updating floating release ${FEED_TAG}…`);
  const uploaded = runGh(
    ['release', 'upload', FEED_TAG, FEED_JS, FEED_JSON, '--clobber'],
    { stdio: 'inherit' },
  );
  if (uploaded.status !== 0) process.exit(uploaded.status ?? 1);
}

function commitFeedToMain() {
  spawnSync('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: root });
  spawnSync(
    'git',
    ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'],
    { cwd: root },
  );
  // Stay on current branch in Actions; only stage feed files.
  spawnSync('git', ['add', 'version-feed.js', 'version.json'], { cwd: root });
  const staged = spawnSync('git', ['diff', '--staged', '--quiet'], { cwd: root });
  if (staged.status === 0) {
    console.log('version feed unchanged — skip commit');
    return;
  }
  const msg = `chore: update version feed (${env('BUILD', env('WINDOWS_VERSION', 'feed'))})`;
  const commit = spawnSync('git', ['commit', '-m', msg], {
    cwd: root,
    stdio: 'inherit',
  });
  if (commit.status !== 0) process.exit(commit.status ?? 1);
  const branch = env('GITHUB_REF_NAME', 'main') || 'main';
  const push = spawnSync('git', ['push', 'origin', `HEAD:${branch}`], {
    cwd: root,
    stdio: 'inherit',
  });
  if (push.status !== 0) {
    console.warn('Push of version feed failed (non-fatal for release artifacts).');
  }
}

function main() {
  const feed = buildFeed();
  if (!feed.build && !feed.windowsVersion) {
    console.error('Nothing to publish: set BUILD/NUMBER and/or WINDOWS_VERSION');
    process.exit(1);
  }
  writeFeedFiles(feed);

  if (env('SKIP_GH') === '1') {
    console.log('SKIP_GH=1 — files written only');
    return;
  }
  publishToFloatingRelease();
  if (env('SKIP_COMMIT') !== '1') {
    commitFeedToMain();
  }
}

main();

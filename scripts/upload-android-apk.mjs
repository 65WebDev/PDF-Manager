#!/usr/bin/env node
/**
 * Uploads the Android APK to a GitHub Release.
 *
 * Invoked automatically by scripts\build-windows-exe.ps1 -Android / -AndroidOnly
 * after the APK is built and copied into dist-android\.
 *
 * Skip: ANDROID_SKIP_UPLOAD=1
 *
 * After a successful upload also:
 *   - refreshes the About version-feed (androidVersion, androidApkUrl - the
 *     in-app update downloads that APK) and commits it to the branch
 *   - writes the Android download links into README.md and index.html
 *   - commits/pushes those meta files (unless SKIP_META_COMMIT=1)
 *   - keeps GitHub "Latest" on the newest HTML build-* release, same as the
 *     Windows / Linux uploaders (a semver android-v* tag would otherwise steal it)
 *
 * Requirements:
 *   - GitHub CLI (`gh`) installed and authenticated (`gh auth login`)
 *   - Push access to the repository
 *
 * Release tag: android-v{version} from src-tauri/tauri.conf.json (the same
 * version field the Windows and Linux builds use).
 * Asset: dist-android/PDF-Manager_{version}.apk (signed with your own key -
 * an unsigned APK is refused: it cannot be installed).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const REPO_SLUG = '65WebDev/PDF-Manager';
const README_PATH = join(root, 'README.md');
const INDEX_PATH = join(root, 'index.html');
const DIST_DIR = join(root, 'dist-android');

function envFlag(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function readVersion() {
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  return conf.version || '0.0.0';
}

function resolveBin(name) {
  if (process.platform === 'win32') {
    const where = spawnSync('where.exe', [name], { encoding: 'utf8' });
    const lines = (where.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.find((p) => /\.exe$/i.test(p)) || lines[0] || null;
  }
  const which = spawnSync('which', [name], { encoding: 'utf8' });
  const path = (which.stdout || '').trim();
  return which.status === 0 && path ? path : null;
}

function run(bin, args, opts = {}) {
  return spawnSync(bin, args, { cwd: root, encoding: 'utf8', windowsHide: true, ...opts });
}

function ensureGhAuth(ghBin) {
  const api = run(ghBin, ['api', 'user', '--jq', '.login']);
  const login = (api.stdout || '').trim();
  if (api.status === 0 && login) {
    console.log(`GitHub CLI: вход выполнен как ${login}`);
    return;
  }
  console.error('Не удалось проверить авторизацию GitHub CLI из скрипта.');
  if (api.stderr) console.error(api.stderr.trim());
  console.error('В обычном терминале выполните: gh auth login');
  process.exit(1);
}

function downloadUrl(tag, assetName) {
  return `https://github.com/${REPO_SLUG}/releases/download/${tag}/${encodeURIComponent(assetName)}`;
}

// Bilingual (English first, Russian second), like the Linux release notes.
function buildReleaseNotes({ version, tag, apkName, releaseUrl }) {
  const apkUrl = downloadUrl(tag, apkName);
  const en = [
    `Android app **PDF Document Manager v${version}** (Tauri).`,
    '',
    '### Download',
    `- **APK:** [${apkName}](${apkUrl})`,
    `- Release page: ${releaseUrl}`,
    '',
    '### Install',
    '- Open the downloaded APK on the phone and allow installing apps from this source when asked.',
    '- Android 7.0 or newer (ARM phones and tablets).',
    '',
    "### What's inside",
    '- Offline editor (all libraries bundled into the app)',
    '- Opens PDFs from other apps ("Open with", "Share"); Save, Share and Print go through Android',
    '',
    'Not part of the automatic HTML release pipeline (`build-N`).',
  ].join('\n');
  const ru = [
    `Android-приложение **PDF Document Manager v${version}** (Tauri).`,
    '',
    '### Скачать',
    `- **APK:** [${apkName}](${apkUrl})`,
    `- Страница релиза: ${releaseUrl}`,
    '',
    '### Установка',
    '- Откройте скачанный APK на телефоне и разрешите установку приложений из этого источника, если Android спросит.',
    '- Android 7.0 и новее (телефоны и планшеты на ARM).',
    '',
    '### Что внутри',
    '- Офлайн-редактор (библиотеки встроены в приложение)',
    '- Открывает PDF из других приложений («Открыть с помощью», «Поделиться»); сохранение, «Поделиться» и печать — через Android',
    '',
    'Не является частью автоматического HTML release pipeline (`build-N`).',
  ].join('\n');
  return `${en}\n\n---\n\n${ru}`;
}

// README.md download links of an Android release (any repository, any
// android-v* tag).
const ANDROID_APK_URL_RE =
  /https:\/\/github\.com\/[^\s"'<>|()]+?\/releases\/download\/android-v[^\s"'<>|()/]+\/[^\s"'<>|()/]+?\.apk\b/g;
const ANDROID_TAG_URL_RE = /https:\/\/github\.com\/[^\s"'<>|()]+?\/releases\/tag\/android-v[^\s"'<>|()]+/g;

/**
 * Matched by URL, not by the markup around it: README.md links the APK from
 * an icon and the release page from a line below the icons, once in English
 * and once in Russian - hence global.
 */
export function readmeWithAndroidLinks(text, { tag, apkName }) {
  const apkUrl = downloadUrl(tag, apkName);
  const tagUrl = `https://github.com/${REPO_SLUG}/releases/tag/${tag}`;
  return text.replace(ANDROID_APK_URL_RE, apkUrl).replace(ANDROID_TAG_URL_RE, tagUrl);
}

function updateReadmeAndroidLinks(info) {
  if (!existsSync(README_PATH)) return false;
  const before = readFileSync(README_PATH, 'utf8');
  if (before.search(ANDROID_APK_URL_RE) < 0) {
    console.warn('README.md: ссылка на APK не найдена — проверьте блок «Download / Скачать».');
  }
  const text = readmeWithAndroidLinks(before, info);
  if (text === before) {
    console.log('README.md уже содержит актуальные Android-ссылки.');
    return false;
  }
  writeFileSync(README_PATH, text, 'utf8');
  console.log('README.md: обновлены ссылки на', info.tag);
  return true;
}

export function indexWithAndroidLinks(text, { tag, apkName }) {
  const apkUrl = downloadUrl(tag, apkName);
  if (text.includes('id="downloadAndroidApkBtn"')) {
    text = text.replace(/id="downloadAndroidApkBtn" href="[^"]+"/, `id="downloadAndroidApkBtn" href="${apkUrl}"`);
  } else {
    text = text.replace(
      /(\s*<a class="btn btn-secondary" id="downloadLinuxAppImageBtn"[^>]*>[\s\S]*?<\/a>\n)/,
      `$1      <a class="btn btn-secondary" id="downloadAndroidApkBtn" href="${apkUrl}">\n` +
        `        <span lang-ru>Android: .apk</span>\n` +
        `        <span lang-en>Android: .apk</span>\n` +
        `      </a>\n`,
    );
  }
  if (text.includes('id="distAndroidBtn"')) {
    text = text.replace(/id="distAndroidBtn" href="[^"]+"/, `id="distAndroidBtn" href="${apkUrl}"`);
  } else {
    text = text.replace(
      /(\s*<div class="dist-card">\s*<span class="d-badge">Linux<\/span>[\s\S]*?<\/div>\n)(\s*<\/div>\n\s*<\/section>)/,
      `$1      <div class="dist-card">\n` +
        `        <span class="d-badge">Android</span>\n` +
        `        <h3><span lang-ru>Приложение для Android</span><span lang-en>Android app</span></h3>\n` +
        `        <p>\n` +
        `          <span lang-ru>APK для телефонов и планшетов: открывает PDF из других приложений, сохраняет, отправляет и печатает через Android.</span>\n` +
        `          <span lang-en>An APK for phones and tablets: opens PDFs from other apps, saves, shares and prints through Android.</span>\n` +
        `        </p>\n` +
        `        <a class="btn btn-secondary" id="distAndroidBtn" href="${apkUrl}" style="width:100%; justify-content:center;">\n` +
        `          <span lang-ru>Скачать</span><span lang-en>Download</span>\n` +
        `        </a>\n` +
        `      </div>\n$2`,
    );
  }
  return text;
}

function updateIndexAndroidLinks(info) {
  if (!existsSync(INDEX_PATH)) return false;
  const before = readFileSync(INDEX_PATH, 'utf8');
  const text = indexWithAndroidLinks(before, info);
  if (text === before) {
    console.log('index.html уже содержит актуальные Android-ссылки.');
    return false;
  }
  writeFileSync(INDEX_PATH, text, 'utf8');
  console.log('index.html: обновлены ссылки на', info.tag);
  return true;
}

function commitAndPushReleaseMeta(tag, paths) {
  if (envFlag('SKIP_README_COMMIT') || envFlag('SKIP_META_COMMIT')) {
    console.log('SKIP_META_COMMIT — локальные файлы обновлены, commit/push пропущен.');
    return;
  }
  const gitBin = resolveBin('git');
  if (!gitBin) {
    console.warn('git не найден в PATH — README/version-feed не запушены.');
    return;
  }
  const rel = paths.filter((p) => existsSync(p)).map((p) => p.slice(root.length).replace(/^[/\\]/, ''));
  if (!rel.length) return;
  run(gitBin, ['add', '--', ...rel]);
  const status = run(gitBin, ['status', '--porcelain', '--', ...rel]);
  if (!(status.stdout || '').trim()) {
    console.log('Метаданные релиза не изменились в git — commit не нужен.');
    return;
  }
  let name = (run(gitBin, ['config', '--get', 'user.name']).stdout || '').trim();
  let email = (run(gitBin, ['config', '--get', 'user.email']).stdout || '').trim();
  if (!name) name = 'PDF Manager Build';
  if (!email) email = 'pdf-manager-build@users.noreply.github.com';
  const commit = run(
    gitBin,
    ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', `docs: sync Android ${tag} release links and version feed`],
    { stdio: 'inherit' },
  );
  if (commit.status !== 0) {
    console.warn('Не удалось закоммитить метаданные Android-релиза.');
    return;
  }
  const branch = (run(gitBin, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || 'main';
  const push = run(gitBin, ['push', 'origin', `HEAD:${branch}`], { stdio: 'inherit' });
  if (push.status !== 0) {
    console.warn(`Push в origin/${branch} не удался (релиз уже загружен).`);
  } else {
    console.log(`Метаданные Android-релиза запушены в origin/${branch}.`);
  }
}

/** A semver android-v* tag must not take GitHub "Latest" from the HTML build-* release. */
function ensureHtmlBuildIsLatest(ghBin, androidTag) {
  run(ghBin, ['release', 'edit', androidTag, '--latest=false'], { stdio: 'inherit' });
  const list = run(ghBin, ['release', 'list', '--limit', '100', '--json', 'tagName,isDraft']);
  if (list.status !== 0 || !list.stdout) return;
  let best = null;
  let bestNum = -1;
  try {
    for (const rel of JSON.parse(list.stdout)) {
      if (!rel || rel.isDraft) continue;
      const m = /^build-(\d+)$/i.exec(String(rel.tagName || ''));
      if (m && Number(m[1]) > bestNum) {
        bestNum = Number(m[1]);
        best = rel.tagName;
      }
    }
  } catch {
    return;
  }
  if (best) run(ghBin, ['release', 'edit', best, '--latest'], { stdio: 'inherit' });
}

function main() {
  if (envFlag('ANDROID_SKIP_UPLOAD')) {
    console.log('ANDROID_SKIP_UPLOAD set — пропускаю загрузку на GitHub.');
    return;
  }
  const ghBin = resolveBin('gh');
  if (!ghBin) {
    console.error('GitHub CLI (gh) не найден в PATH. Установите: https://cli.github.com/ и выполните gh auth login');
    process.exit(1);
  }
  ensureGhAuth(ghBin);

  const version = readVersion();
  const tag = `android-v${version}`;
  const apkPath = join(DIST_DIR, `PDF-Manager_${version}.apk`);
  if (!existsSync(apkPath)) {
    console.error(`Не найден ${apkPath}.`);
    console.error('Соберите его сначала: .\\scripts\\build-windows-exe.ps1 -AndroidOnly');
    process.exit(1);
  }
  const apkName = basename(apkPath);
  const releaseUrl = `https://github.com/${REPO_SLUG}/releases/tag/${tag}`;
  const notesPath = join(root, '.android-release-notes.tmp.md');
  writeFileSync(notesPath, buildReleaseNotes({ version, tag, apkName, releaseUrl }), 'utf8');
  try {
    const exists = run(ghBin, ['release', 'view', tag], { stdio: 'ignore' }).status === 0;
    const res = exists
      ? run(ghBin, ['release', 'upload', tag, apkPath, '--clobber'], { stdio: 'inherit' })
      : run(ghBin, ['release', 'create', tag, apkPath, '--title', `Android build v${version}`, '--notes-file', notesPath, '--latest=false'], { stdio: 'inherit' });
    if (res.status !== 0) process.exit(res.status ?? 1);
    if (exists) {
      run(ghBin, ['release', 'edit', tag, '--title', `Android build v${version}`, '--notes-file', notesPath, '--latest=false'], { stdio: 'inherit' });
    }
  } finally {
    try { if (existsSync(notesPath)) unlinkSync(notesPath); } catch { /* ignore */ }
  }

  ensureHtmlBuildIsLatest(ghBin, tag);
  console.log('\nГотово:', releaseUrl);

  console.log('Обновляю version-feed (Android)…');
  const feed = spawnSync(process.platform === 'win32' ? 'node.exe' : 'node', [join(root, 'scripts', 'publish-version-feed.mjs')], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      ANDROID_VERSION: version,
      ANDROID_DOWNLOAD_URL: releaseUrl,
      ANDROID_APK_URL: `https://github.com/${REPO_SLUG}/releases/download/${tag}/${apkName}`,
      SKIP_COMMIT: '1',
    },
    stdio: 'inherit',
  });
  if (feed.status !== 0) console.warn('version-feed обновить не удалось (APK уже загружен).');

  updateReadmeAndroidLinks({ tag, apkName });
  updateIndexAndroidLinks({ tag, apkName });
  commitAndPushReleaseMeta(tag, [README_PATH, INDEX_PATH, join(root, 'version.json'), join(root, 'version-feed.js')]);
}

// Run only as a script (the link helpers above are importable for checks).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

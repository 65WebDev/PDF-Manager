#!/usr/bin/env node
/**
 * Uploads the Linux .deb / .AppImage bundles to a GitHub Release.
 *
 * Invoked automatically by scripts\build-windows-exe.ps1 -Linux (from the
 * Windows side, after WSL2 finishes the build and copies artifacts into
 * dist-linux\ — that folder is visible through the Windows filesystem, and
 * `gh` is already authenticated there for the Windows upload step).
 *
 * Skip: LINUX_SKIP_UPLOAD=1
 *
 * After a successful upload also:
 *   - refreshes the About version-feed (linuxVersion) and commits it to the branch
 *   - rewrites Linux download links in README.md and index.html
 *   - commits/pushes those meta files (unless SKIP_META_COMMIT=1)
 *   - keeps GitHub "Latest" on the newest HTML build-* release, same as the
 *     Windows uploader (a semver linux-v* tag would otherwise steal it)
 *
 * Requirements:
 *   - GitHub CLI (`gh`) installed and authenticated (`gh auth login`)
 *   - Push access to the repository
 *
 * Release tag: linux-v{version} from src-tauri/tauri.conf.json (same version
 * field the Windows build uses — one app version, one tag per platform).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const REPO_SLUG = '65WebDev/PDF-Manager';
const README_PATH = join(root, 'README.md');
const INDEX_PATH = join(root, 'index.html');
const DIST_DIR = join(root, 'dist-linux');

function skipUpload() {
  const v = String(process.env.LINUX_SKIP_UPLOAD || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function envFlag(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function readVersion() {
  const confPath = join(root, 'src-tauri', 'tauri.conf.json');
  const conf = JSON.parse(readFileSync(confPath, 'utf8'));
  return conf.version || '0.0.0';
}

/** Resolve a real gh binary. Prefer gh.exe on Windows (avoid gh.cmd + shell quirks). */
function resolveGhBin() {
  if (process.platform === 'win32') {
    const where = spawnSync('where.exe', ['gh'], { encoding: 'utf8' });
    const lines = (where.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const exe = lines.find((p) => /\.exe$/i.test(p));
    if (exe) return exe;
    if (lines[0]) return lines[0];
    return null;
  }
  const which = spawnSync('which', ['gh'], { encoding: 'utf8' });
  const path = (which.stdout || '').trim();
  return which.status === 0 && path ? path : null;
}

function runGh(ghBin, args, opts = {}) {
  const r = spawnSync(ghBin, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  });
  return r;
}

function ensureGhAuth(ghBin) {
  const api = runGh(ghBin, ['api', 'user', '--jq', '.login']);
  const login = (api.stdout || '').trim();
  if (api.status === 0 && login) {
    console.log(`GitHub CLI: вход выполнен как ${login}`);
    return login;
  }
  console.error('Не удалось проверить авторизацию GitHub CLI из скрипта.');
  if (api.stderr) console.error(api.stderr.trim());
  console.error('В обычном терминале выполните: gh auth login');
  process.exit(1);
}

function findArtifacts() {
  if (!existsSync(DIST_DIR)) return [];
  const files = [];
  for (const name of readdirSync(DIST_DIR)) {
    if (/\.(deb|appimage)$/i.test(name)) {
      files.push(join(DIST_DIR, name));
    }
  }
  return files;
}

function pickDebArtifact(artifacts) {
  const names = artifacts.map((f) => basename(f));
  return names.find((n) => /\.deb$/i.test(n)) || null;
}

function pickAppImageArtifact(artifacts) {
  const names = artifacts.map((f) => basename(f));
  return names.find((n) => /\.appimage$/i.test(n)) || null;
}

/** GitHub Release asset names cannot contain spaces — uploads rewrite " " → ".". */
function toGithubAssetName(name) {
  return String(name || '').replace(/ /g, '.');
}

function githubDownloadUrl(tag, assetName) {
  const name = toGithubAssetName(assetName);
  return (
    `https://github.com/${REPO_SLUG}/releases/download/${tag}/` +
    encodeURIComponent(name).replace(/%2F/gi, '/')
  );
}

/** Rename local artifacts so uploaded names match GitHub download URLs. */
function normalizeArtifactsForGithub(paths) {
  const out = [];
  for (const p of paths) {
    const base = basename(p);
    const ghName = toGithubAssetName(base);
    if (ghName === base) {
      out.push(p);
      continue;
    }
    const dest = join(dirname(p), ghName);
    if (existsSync(dest)) {
      if (dest !== p && existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
      out.push(dest);
      continue;
    }
    renameSync(p, dest);
    console.log(`Asset rename for GitHub: "${base}" → "${ghName}"`);
    out.push(dest);
  }
  return out;
}

function releaseExists(ghBin, tag) {
  const r = runGh(ghBin, ['release', 'view', tag], { stdio: 'ignore' });
  return r.status === 0;
}

function buildReleaseNotes({ version, tag, debName, appImageName, releaseUrl }) {
  const debAsset = debName ? toGithubAssetName(debName) : null;
  const appImageAsset = appImageName ? toGithubAssetName(appImageName) : null;
  const debUrl = debAsset ? githubDownloadUrl(tag, debAsset) : releaseUrl;
  const appImageUrl = appImageAsset ? githubDownloadUrl(tag, appImageAsset) : releaseUrl;

  return [
    `Linux-приложение PDF Manager **v${version}** (Tauri).`,
    '',
    '### Скачать',
    debAsset ? `- **Пакет .deb (Debian/Ubuntu):** [${debAsset}](${debUrl})` : null,
    appImageAsset ? `- **.AppImage (любой дистрибутив):** [${appImageAsset}](${appImageUrl})` : null,
    `- Страница релиза: ${releaseUrl}`,
    '',
    '### Установка',
    debAsset ? `- \`.deb\`: \`sudo apt install ./${debAsset}\` (или двойной клик в файловом менеджере)` : null,
    appImageAsset ? `- \`.AppImage\`: \`chmod +x ${appImageAsset} && ./${appImageAsset}\`` : null,
    '',
    '### Что внутри',
    '- Офлайн-редактор (библиотеки встроены в UI)',
    '',
    'Не является частью автоматического HTML release pipeline (`build-N`).',
  ]
    .filter((line) => line != null)
    .join('\n');
}

function updateReadmeLinuxLinks({ version, tag, debName, appImageName }) {
  if (!existsSync(README_PATH)) {
    console.warn('README.md не найден — пропускаю обновление ссылок.');
    return false;
  }

  const debFile = toGithubAssetName(debName || `pdf-manager_${version}_amd64.deb`);
  const appImageFile = toGithubAssetName(appImageName || `pdf-manager_${version}_amd64.AppImage`);
  const debUrl = githubDownloadUrl(tag, debFile);
  const appImageUrl = githubDownloadUrl(tag, appImageFile);
  const tagUrl = `https://github.com/${REPO_SLUG}/releases/tag/${tag}`;

  let text = readFileSync(README_PATH, 'utf8');
  const before = text;

  const hasLinuxRow = /\|\s*\*\*Linux: `\.deb`\*\*/.test(text);
  if (hasLinuxRow) {
    // Match the row by its label, replacing whatever URL currently sits in the
    // cell — covers both the initial generic /releases placeholder and any
    // previously-published linux-v* URL.
    text = text.replace(
      /(\|\s*\*\*Linux: `\.deb`\*\*\s*\|\s*)[^\n|]+(\s*\|)/,
      `$1${debUrl}$2`,
    );
    text = text.replace(
      /(\|\s*\*\*Linux: `\.AppImage`\*\*\s*\|\s*)[^\n|]+(\s*\|)/,
      `$1${appImageUrl}$2`,
    );
    text = text.replace(
      /(\|\s*\*\*Релиз Linux\*\*\s*\|\s*)[^\n|]+(\s*\|)/,
      `$1${tagUrl}$2`,
    );
  } else {
    // First-ever Linux release: insert rows right after the Windows portable row.
    text = text.replace(
      /(\|\s*\*\*Windows: portable `\.exe`\*\*\s*\|[^\n]+\|\n)/,
      `$1| **Linux: \`.deb\`** | ${debUrl} |\n| **Linux: \`.AppImage\`** | ${appImageUrl} |\n`,
    );
    text = text.replace(
      /(\|\s*\*\*Релиз Windows\*\*\s*\|[^\n]+\|\n)/,
      `$1| **Релиз Linux** | ${tagUrl} |\n`,
    );
  }

  if (text === before) {
    console.log('README.md уже содержит актуальные Linux-ссылки.');
    return false;
  }
  writeFileSync(README_PATH, text, 'utf8');
  console.log('README.md: обновлены ссылки на', tag);
  return true;
}

function updateIndexLinuxLinks({ version, tag, debName, appImageName }) {
  if (!existsSync(INDEX_PATH)) {
    console.warn('index.html не найден — пропускаю обновление ссылок.');
    return false;
  }
  const debFile = toGithubAssetName(debName || `pdf-manager_${version}_amd64.deb`);
  const appImageFile = toGithubAssetName(appImageName || `pdf-manager_${version}_amd64.AppImage`);
  const debUrl = githubDownloadUrl(tag, debFile);
  const appImageUrl = githubDownloadUrl(tag, appImageFile);

  let text = readFileSync(INDEX_PATH, 'utf8');
  const before = text;

  if (text.includes('id="downloadLinuxDebBtn"')) {
    text = text.replace(
      /id="downloadLinuxDebBtn" href="[^"]+"/,
      `id="downloadLinuxDebBtn" href="${debUrl}"`,
    );
    text = text.replace(
      /id="downloadLinuxAppImageBtn" href="[^"]+"/,
      `id="downloadLinuxAppImageBtn" href="${appImageUrl}"`,
    );
  } else {
    // First-ever Linux release: add quick-download buttons next to the Windows ones.
    text = text.replace(
      /(\s*<a class="btn btn-secondary" id="downloadWindowsPortableBtn"[^>]*>[\s\S]*?<\/a>\n)/,
      `$1      <a class="btn btn-secondary" id="downloadLinuxDebBtn" href="${debUrl}">\n` +
        `        <span lang-ru>Linux: .deb</span>\n` +
        `        <span lang-en>Linux: .deb</span>\n` +
        `      </a>\n` +
        `      <a class="btn btn-secondary" id="downloadLinuxAppImageBtn" href="${appImageUrl}">\n` +
        `        <span lang-ru>Linux: .AppImage</span>\n` +
        `        <span lang-en>Linux: .AppImage</span>\n` +
        `      </a>\n`,
    );
  }

  if (text.includes('id="distLinuxBtn"')) {
    text = text.replace(
      /id="distLinuxBtn" href="[^"]+"/,
      `id="distLinuxBtn" href="${debUrl}"`,
    );
  } else {
    // First-ever Linux release: add a distribution card next to the Windows one.
    text = text.replace(
      /(\s*<div class="dist-card">\s*<span class="d-badge">Windows<\/span>[\s\S]*?<\/div>\n)(\s*<\/div>\n\s*<\/section>)/,
      `$1      <div class="dist-card">\n` +
        `        <span class="d-badge">Linux</span>\n` +
        `        <h3><span lang-ru>Приложение для Linux</span><span lang-en>Linux app</span></h3>\n` +
        `        <p>\n` +
        `          <span lang-ru>Нативная десктопная сборка: пакет .deb или переносимый .AppImage.</span>\n` +
        `          <span lang-en>A native desktop build: .deb package or a portable .AppImage.</span>\n` +
        `        </p>\n` +
        `        <a class="btn btn-secondary" id="distLinuxBtn" href="${debUrl}" style="width:100%; justify-content:center;">\n` +
        `          <span lang-ru>Скачать</span><span lang-en>Download</span>\n` +
        `        </a>\n` +
        `      </div>\n$2`,
    );
  }

  if (text === before) {
    console.log('index.html уже содержит актуальные Linux-ссылки.');
    return false;
  }
  writeFileSync(INDEX_PATH, text, 'utf8');
  console.log('index.html: обновлены ссылки на', tag);
  return true;
}

function resolveGitBin() {
  if (process.platform === 'win32') {
    const where = spawnSync('where.exe', ['git'], { encoding: 'utf8' });
    const lines = (where.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const exe = lines.find((p) => /\.exe$/i.test(p));
    return exe || lines[0] || null;
  }
  const which = spawnSync('which', ['git'], { encoding: 'utf8' });
  const path = (which.stdout || '').trim();
  return which.status === 0 && path ? path : null;
}

function commitAndPushReleaseMeta(version, tag, paths) {
  if (envFlag('SKIP_README_COMMIT') || envFlag('SKIP_META_COMMIT')) {
    console.log('SKIP_META_COMMIT — локальные файлы обновлены, commit/push пропущен.');
    return;
  }

  const gitBin = resolveGitBin();
  if (!gitBin) {
    console.warn('git не найден в PATH — README/version-feed не запушены.');
    for (const p of paths) console.warn('  -', p);
    return;
  }

  const existing = paths.filter((p) => existsSync(p));
  if (!existing.length) return;

  const run = (args, opts = {}) =>
    spawnSync(gitBin, args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      ...opts,
    });

  const rel = existing.map((p) => {
    if (p.startsWith(root)) return p.slice(root.length).replace(/^[/\\]/, '');
    return p;
  });
  run(['add', '--', ...rel]);

  const status = run(['status', '--porcelain', '--', ...rel]);
  if (!(status.stdout || '').trim()) {
    console.log('Метаданные релиза не изменились в git — commit не нужен.');
    return;
  }

  let name = (run(['config', '--get', 'user.name']).stdout || '').trim();
  let email = (run(['config', '--get', 'user.email']).stdout || '').trim();
  if (!name || !email) {
    const ghBin = resolveGhBin();
    if (ghBin) {
      const api = runGh(ghBin, ['api', 'user', '--jq', '.login']);
      const login = (api.stdout || '').trim();
      if (api.status === 0 && login) {
        if (!name) name = login;
        if (!email) email = `${login}@users.noreply.github.com`;
      }
    }
  }
  if (!name) name = 'PDF Manager Build';
  if (!email) email = 'pdf-manager-build@users.noreply.github.com';

  const commit = run(
    [
      '-c',
      `user.name=${name}`,
      '-c',
      `user.email=${email}`,
      'commit',
      '-m',
      `docs: sync Linux ${tag} release links and version feed`,
    ],
    { stdio: 'inherit' },
  );
  if (commit.status !== 0) {
    console.warn('Не удалось закоммитить метаданные Linux-релиза.');
    return;
  }

  const branch = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || 'main';
  const push = run(['push', 'origin', `HEAD:${branch}`], { stdio: 'inherit' });
  if (push.status !== 0) {
    console.warn(`Push в origin/${branch} не удался (релиз уже загружен).`);
  } else {
    console.log(`Метаданные Linux-релиза запушены в origin/${branch}.`);
  }
}

/**
 * Same "Latest" hazard as Windows: a semver linux-v* tag can steal Latest
 * from the HTML build-* release. Always leave Latest on the newest build-*.
 */
function ensureHtmlBuildIsLatest(ghBin, linuxTag) {
  const unpin = runGh(ghBin, ['release', 'edit', linuxTag, '--latest=false'], {
    stdio: 'inherit',
  });
  if (unpin.status !== 0) {
    console.warn(`WARN: could not clear Latest on ${linuxTag}`);
  }

  const list = runGh(ghBin, [
    'release',
    'list',
    '--limit',
    '100',
    '--json',
    'tagName,isDraft,isPrerelease',
  ]);
  if (list.status !== 0 || !list.stdout) {
    console.warn('WARN: could not list releases to restore HTML Latest.');
    return;
  }
  let releases = [];
  try {
    releases = JSON.parse(list.stdout);
  } catch (err) {
    console.warn('WARN: bad release list JSON:', err && err.message ? err.message : err);
    return;
  }

  let bestTag = null;
  let bestNum = -1;
  for (const rel of releases) {
    if (!rel || rel.isDraft) continue;
    const m = /^build-(\d+)$/i.exec(String(rel.tagName || ''));
    if (!m) continue;
    const n = Number(m[1]) || 0;
    if (n > bestNum) {
      bestNum = n;
      bestTag = rel.tagName;
    }
  }
  if (!bestTag) {
    console.warn('WARN: no build-* HTML release found — Latest left unset on Linux tag.');
    return;
  }

  const pin = runGh(ghBin, ['release', 'edit', bestTag, '--latest'], {
    stdio: 'inherit',
  });
  if (pin.status === 0) {
    console.log(`OK  GitHub Latest → ${bestTag} (HTML online/offline downloads).`);
  } else {
    console.warn(`WARN: could not mark ${bestTag} as Latest.`);
  }
}

function main() {
  if (skipUpload()) {
    console.log('LINUX_SKIP_UPLOAD set — пропускаю загрузку на GitHub.');
    return;
  }

  const ghBin = resolveGhBin();
  if (!ghBin) {
    console.error('GitHub CLI (gh) не найден в PATH.');
    console.error('Установите: https://cli.github.com/');
    console.error('Затем: gh auth login');
    process.exit(1);
  }
  console.log('gh binary:', ghBin);

  ensureGhAuth(ghBin);

  const version = readVersion();
  const tag = `linux-v${version}`;
  const title = `Linux build v${version}`;

  let artifacts = findArtifacts();
  if (!artifacts.length) {
    console.error('Не найдены .deb/.AppImage в dist-linux/.');
    console.error('Соберите их сначала: .\\scripts\\build-windows-exe.ps1 -Linux');
    process.exit(1);
  }
  artifacts = normalizeArtifactsForGithub(artifacts);

  const debName = pickDebArtifact(artifacts);
  const appImageName = pickAppImageArtifact(artifacts);
  const releaseUrl = `https://github.com/${REPO_SLUG}/releases/tag/${tag}`;
  const notes = buildReleaseNotes({ version, tag, debName, appImageName, releaseUrl });

  console.log('Артефакты для загрузки:');
  for (const f of artifacts) console.log('  -', f);

  const notesPath = join(root, '.linux-release-notes.tmp.md');
  writeFileSync(notesPath, notes, 'utf8');

  try {
    if (!releaseExists(ghBin, tag)) {
      console.log(`Создаю release ${tag}…`);
      const created = runGh(
        ghBin,
        [
          'release',
          'create',
          tag,
          ...artifacts,
          '--title',
          title,
          '--notes-file',
          notesPath,
          '--latest=false',
        ],
        { stdio: 'inherit' },
      );
      if (created.status !== 0) process.exit(created.status ?? 1);
    } else {
      console.log(`Release ${tag} уже есть — обновляю файлы (--clobber)…`);
      const uploaded = runGh(
        ghBin,
        ['release', 'upload', tag, ...artifacts, '--clobber'],
        { stdio: 'inherit' },
      );
      if (uploaded.status !== 0) process.exit(uploaded.status ?? 1);

      runGh(
        ghBin,
        ['release', 'edit', tag, '--title', title, '--notes-file', notesPath, '--latest=false'],
        { stdio: 'inherit' },
      );
    }
  } finally {
    try {
      if (existsSync(notesPath)) unlinkSync(notesPath);
    } catch { /* ignore */ }
  }

  ensureHtmlBuildIsLatest(ghBin, tag);

  const view = runGh(ghBin, ['release', 'view', tag, '--json', 'url']);
  let finalReleaseUrl = releaseUrl;
  if (view.status === 0 && view.stdout) {
    try {
      const { url } = JSON.parse(view.stdout);
      if (url) finalReleaseUrl = url;
      console.log('\nГотово:', url);
    } catch {
      console.log('\nГотово. Тег release:', tag);
    }
  } else {
    console.log('\nГотово. Тег release:', tag);
  }

  console.log('Обновляю version-feed (Linux)…');
  const feed = spawnSync(
    process.platform === 'win32' ? 'node.exe' : 'node',
    [join(root, 'scripts', 'publish-version-feed.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        LINUX_VERSION: version,
        LINUX_DOWNLOAD_URL: finalReleaseUrl,
        SKIP_COMMIT: '1',
      },
      stdio: 'inherit',
    },
  );
  if (feed.status !== 0) {
    console.warn('version-feed обновить не удалось (сборка уже загружена).');
  }

  updateReadmeLinuxLinks({ version, tag, debName, appImageName });
  updateIndexLinuxLinks({ version, tag, debName, appImageName });
  commitAndPushReleaseMeta(version, tag, [
    join(root, 'README.md'),
    join(root, 'index.html'),
    join(root, 'version.json'),
    join(root, 'version-feed.js'),
  ]);
}

main();

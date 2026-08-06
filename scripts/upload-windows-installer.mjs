#!/usr/bin/env node
/**
 * Uploads the Windows NSIS installer (and portable .exe) to a GitHub Release.
 *
 * Invoked automatically after `npm run tauri:build` unless:
 *   TAURI_SKIP_UPLOAD=1
 *
 * After a successful upload also:
 *   - refreshes the About version-feed (windowsVersion) and commits it to the branch
 *   - rewrites Windows download links in README.md and index.html
 *   - commits/pushes those meta files (unless SKIP_META_COMMIT=1)
 *   - updates the GitHub repository description with the current Windows tag
 *   - rewrites the release notes body and drops leftover setup assets from older versions
 *   - keeps GitHub "Latest" on the newest HTML build-* release (so
 *     /releases/latest/download/PDF_manager_*.html keeps working; Windows
 *     tags use --latest=false because semver would otherwise steal Latest)
 *
 * Requirements:
 *   - GitHub CLI (`gh`) installed and authenticated (`gh auth login`)
 *   - Push access to the repository
 *
 * Release tag: windows-v{version} from src-tauri/tauri.conf.json
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

function skipUpload() {
  const v = String(process.env.TAURI_SKIP_UPLOAD || '').trim().toLowerCase();
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
  // Do NOT use shell:true on Windows — it breaks argument passing for gh.cmd
  // and makes `gh auth status` look "unauthorized" even when logged in.
  const r = spawnSync(ghBin, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  });
  return r;
}

function runGit(args, opts = {}) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  });
}

function ensureGhAuth(ghBin) {
  // Real auth check: call the API. `gh auth status` exit codes are unreliable
  // when invoked from npm scripts on Windows.
  const api = runGh(ghBin, ['api', 'user', '--jq', '.login']);
  const login = (api.stdout || '').trim();
  if (api.status === 0 && login) {
    console.log(`GitHub CLI: вход выполнен как ${login}`);
    return login;
  }

  console.error('Не удалось проверить авторизацию GitHub CLI из скрипта.');
  if (api.stderr) console.error(api.stderr.trim());
  if (api.error) console.error(String(api.error));
  console.error('');
  console.error('В обычном терминале выполните:');
  console.error('  gh auth status');
  console.error('  gh api user --jq .login');
  console.error('Если там всё ок, а скрипт всё равно падает — пришлите вывод этих двух команд.');
  console.error('Повторный вход: gh auth login');
  console.error('Сборка без загрузки: npm run tauri:build:local');
  process.exit(1);
}

function findArtifacts(version) {
  const nsisDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const releaseDir = join(root, 'src-tauri', 'target', 'release');
  const files = [];

  if (existsSync(nsisDir)) {
    for (const name of readdirSync(nsisDir)) {
      const lower = name.toLowerCase();
      if (!lower.endsWith('.exe')) continue;
      // bundle/nsis/ is never cleaned between builds, so installers from
      // older versions pile up there - only the current version's setup
      // exe belongs in this release's upload.
      if (lower.endsWith('setup.exe') && !name.includes(version)) {
        console.log(`Пропускаю установщик старой версии: ${name}`);
        continue;
      }
      files.push(join(nsisDir, name));
    }
  }

  // Portable binary next to the installer (optional). Unversioned filename,
  // cargo overwrites it in place each build - no stale-version filtering needed.
  if (existsSync(releaseDir)) {
    for (const name of readdirSync(releaseDir)) {
      if (!name.toLowerCase().endsWith('.exe')) continue;
      if (name.toLowerCase().includes('setup')) continue;
      files.push(join(releaseDir, name));
    }
  }

  const seen = new Set();
  const unique = [];
  for (const f of files) {
    const base = basename(f);
    if (seen.has(base)) continue;
    seen.add(base);
    unique.push(f);
  }
  return unique;
}

function pickSetupArtifact(artifacts, version) {
  const names = artifacts.map((f) => basename(f));
  const exact = names.find((n) =>
    new RegExp(`PDF[ .]?Manager[_ ]${version.replace(/\./g, '\\.')}.*setup\\.exe$`, 'i').test(n),
  );
  if (exact) return exact;
  const anySetup = names.find((n) => /setup\.exe$/i.test(n));
  return anySetup || null;
}

function pickPortableArtifact(artifacts) {
  const names = artifacts.map((f) => basename(f));
  const preferred = names.find((n) => /^pdf-manager\.exe$/i.test(n));
  if (preferred) return preferred;
  return names.find((n) => /\.exe$/i.test(n) && !/setup\.exe$/i.test(n)) || null;
}

/**
 * GitHub Release asset names cannot contain spaces — uploads rewrite " " → ".".
 * Use the same name in download URLs or links 404 (PDF%20Manager_… vs PDF.Manager_…).
 */
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

/**
 * Rename local artifacts so uploaded names match GitHub download URLs.
 * bundle/nsis/ is never cleaned between builds, and Tauri always writes the
 * installer as "PDF Manager_X_x64-setup.exe" (space) fresh - if a PREVIOUS
 * run already renamed that same filename to the dot form and left it
 * sitting there, findArtifacts() picks up both as separate entries. The
 * freshly-built file is always the one that just came out of `tauri build`
 * (the `p` argument here) - overwrite any stale dot-named leftover with it
 * rather than keeping the old one, otherwise today's build silently never
 * gets uploaded, and passing the same resulting path twice to
 * `gh release upload` is what 404s the --clobber flow.
 */
function normalizeArtifactsForGithub(paths) {
  const out = [];
  const seenDest = new Set();
  for (const p of paths) {
    const base = basename(p);
    const ghName = toGithubAssetName(base);
    const dest = ghName === base ? p : join(dirname(p), ghName);
    if (seenDest.has(dest)) continue; // already normalized to this path this run
    if (ghName !== base) {
      if (existsSync(dest)) {
        try {
          unlinkSync(dest);
        } catch {
          /* ignore */
        }
      }
      renameSync(p, dest);
      console.log(`Asset rename for GitHub: "${base}" → "${ghName}"`);
    }
    seenDest.add(dest);
    out.push(dest);
  }
  return out;
}

function releaseExists(ghBin, tag) {
  const r = runGh(ghBin, ['release', 'view', tag], { stdio: 'ignore' });
  return r.status === 0;
}

function buildReleaseNotes({ version, tag, setupName, portableName, releaseUrl }) {
  const setupAsset = setupName ? toGithubAssetName(setupName) : null;
  const portableAsset = portableName ? toGithubAssetName(portableName) : null;
  const setupUrl = setupAsset ? githubDownloadUrl(tag, setupAsset) : releaseUrl;
  const portableUrl = portableAsset ? githubDownloadUrl(tag, portableAsset) : releaseUrl;

  return [
    `Windows-приложение PDF Manager **v${version}** (Tauri).`,
    '',
    '### Скачать',
    setupAsset ? `- **Установщик (NSIS):** [${setupAsset}](${setupUrl})` : null,
    portableAsset ? `- **Portable .exe:** [${portableAsset}](${portableUrl})` : null,
    `- Страница релиза: ${releaseUrl}`,
    '',
    '### Что внутри',
    '- Установщик NSIS регистрирует ассоциацию с `.pdf`',
    '- После установки: ПКМ по PDF → «Открыть с помощью» → PDF Manager',
    '- Офлайн-редактор (библиотеки встроены в UI)',
    '',
    'Не является частью автоматического HTML release pipeline (`build-N`).',
  ]
    .filter((line) => line != null)
    .join('\n');
}

/**
 * Rewrite Windows download rows / “актуальная версия” line in README.md.
 * Returns true if the file changed.
 */
function updateReadmeWindowsLinks({ version, tag, setupName, portableName }) {
  if (!existsSync(README_PATH)) {
    console.warn('README.md не найден — пропускаю обновление ссылок.');
    return false;
  }

  const setupFile = toGithubAssetName(setupName || `PDF.Manager_${version}_x64-setup.exe`);
  const portableFile = toGithubAssetName(portableName || 'pdf-manager.exe');
  // GitHub release asset URLs: spaces become "." on upload — never use %20.
  const setupUrl = githubDownloadUrl(tag, setupFile);
  const portableUrl = githubDownloadUrl(tag, portableFile);
  const tagUrl = `https://github.com/${REPO_SLUG}/releases/tag/${tag}`;

  let text = readFileSync(README_PATH, 'utf8');
  const before = text;

  text = text.replace(
    /\|\s*\*\*Windows: установщик\*\*\s*\|\s*https:\/\/github\.com\/[^|\s]+\/releases\/download\/windows-v[^|\s]+\/[^\s|]+\s*\|/,
    `| **Windows: установщик** | ${setupUrl} |`,
  );
  text = text.replace(
    /\|\s*\*\*Windows: portable `\.exe`\*\*\s*\|\s*https:\/\/github\.com\/[^|\s]+\/releases\/download\/windows-v[^|\s]+\/[^\s|]+\s*\|/,
    `| **Windows: portable \`.exe\`** | ${portableUrl} |`,
  );
  text = text.replace(
    /\|\s*\*\*Релиз Windows\*\*\s*\|\s*https:\/\/github\.com\/[^|\s]+\/releases\/tag\/windows-v[^|\s]+\s*\|/,
    `| **Релиз Windows** | ${tagUrl} |`,
  );
  text = text.replace(
    /Актуальная версия сейчас:\s*\[[^\]]*\]\([^)]+\)/,
    `Актуальная версия сейчас: [${tag}](${tagUrl})`,
  );
  // Broader fallback for any leftover version pins in the quick-download block.
  text = text.replace(/windows-v\d+\.\d+\.\d+/g, tag);
  text = text.replace(/PDF(?:\.|%20| )Manager_\d+\.\d+\.\d+_x64-setup\.exe/g, setupFile);

  if (text === before) {
    console.log('README.md уже содержит актуальные Windows-ссылки.');
    return false;
  }
  writeFileSync(README_PATH, text, 'utf8');
  console.log('README.md: обновлены ссылки на', tag);
  return true;
}

/**
 * Update fallback Windows download hrefs on the GitHub Pages landing page.
 * Runtime JS still prefers version.json when available.
 */
function updateIndexWindowsLinks({ version, tag, setupName, portableName }) {
  if (!existsSync(INDEX_PATH)) {
    console.warn('index.html не найден — пропускаю обновление ссылок.');
    return false;
  }
  const setupFile = toGithubAssetName(setupName || `PDF.Manager_${version}_x64-setup.exe`);
  const portableFile = toGithubAssetName(portableName || 'pdf-manager.exe');
  const setupUrl = githubDownloadUrl(tag, setupFile);
  const portableUrl = githubDownloadUrl(tag, portableFile);

  let text = readFileSync(INDEX_PATH, 'utf8');
  const before = text;
  text = text.replace(
    /id="downloadWindowsSetupBtn" href="[^"]+"/,
    `id="downloadWindowsSetupBtn" href="${setupUrl}"`,
  );
  text = text.replace(
    /id="downloadWindowsPortableBtn" href="[^"]+"/,
    `id="downloadWindowsPortableBtn" href="${portableUrl}"`,
  );
  if (text === before) {
    console.log('index.html уже содержит актуальные Windows-ссылки.');
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
    console.warn('Добавьте Git в PATH или выполните вручную: git add/commit/push для');
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

  // Build PCs often have no git user.name/email — use gh login for this commit only.
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
      `docs: sync Windows ${tag} release links and version feed`,
    ],
    { stdio: 'inherit' },
  );
  if (commit.status !== 0) {
    console.warn('Не удалось закоммитить метаданные Windows-релиза.');
    return;
  }

  const branch = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || 'main';
  const push = run(['push', 'origin', `HEAD:${branch}`], { stdio: 'inherit' });
  if (push.status !== 0) {
    console.warn(`Push в origin/${branch} не удался (релиз уже загружен).`);
  } else {
    console.log(`Метаданные Windows-релиза запушены в origin/${branch}.`);
  }
}

/** Remove leftover setup exes from this tag that do not match the current version. */
function pruneStaleSetupAssets(ghBin, tag, version, keepNames) {
  const view = runGh(ghBin, ['release', 'view', tag, '--json', 'assets']);
  if (view.status !== 0 || !view.stdout) return;
  let assets = [];
  try {
    assets = JSON.parse(view.stdout).assets || [];
  } catch {
    return;
  }
  const keep = new Set(
    (keepNames || []).filter(Boolean).map((n) => toGithubAssetName(n)),
  );
  for (const asset of assets) {
    const name = String(asset.name || '');
    if (!/setup\.exe$/i.test(name)) continue;
    if (keep.has(name)) continue;
    // Only drop other PDF Manager setup builds on this same tag.
    if (!/PDF[ .]?Manager/i.test(name)) continue;
    if (name.includes(version)) continue;
    console.log(`Удаляю устаревший asset с ${tag}: ${name}`);
    runGh(ghBin, ['release', 'delete-asset', tag, name, '--yes'], { stdio: 'inherit' });
  }
}

function updateRepoDescription(ghBin, version, tag) {
  if (envFlag('SKIP_REPO_DESCRIPTION')) return;
  const description =
    `PDF Document Manager — HTML builds + Windows desktop (актуально: ${tag}).`;
  const homepage = `https://github.com/${REPO_SLUG}/releases/tag/${tag}`;
  const r = runGh(ghBin, [
    'api',
    '-X',
    'PATCH',
    `repos/${REPO_SLUG}`,
    '-f',
    `description=${description}`,
    '-f',
    `homepage=${homepage}`,
  ]);
  if (r.status === 0) {
    console.log('Описание репозитория GitHub обновлено.');
  } else {
    console.warn('Описание репозитория обновить не удалось (нет прав или API).');
    if (r.stderr) console.warn(String(r.stderr).trim());
  }
}

/**
 * GitHub allows only one "Latest" release. `gh release create` may mark a new
 * windows-v* tag as Latest (semver vs build-N), which breaks
 * /releases/latest/download/PDF_manager_online.html (404 — no HTML assets).
 * Always leave Latest on the newest non-draft build-* HTML release.
 */
function ensureHtmlBuildIsLatest(ghBin, windowsTag) {
  const unpin = runGh(ghBin, ['release', 'edit', windowsTag, '--latest=false'], {
    stdio: 'inherit',
  });
  if (unpin.status !== 0) {
    console.warn(`WARN: could not clear Latest on ${windowsTag}`);
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
    console.warn('WARN: no build-* HTML release found — Latest left unset on Windows tag.');
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
    console.log('TAURI_SKIP_UPLOAD set — пропускаю загрузку на GitHub.');
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
  const tag = `windows-v${version}`;
  const title = `Windows installer v${version}`;

  let artifacts = findArtifacts(version);
  if (!artifacts.length) {
    console.error('Не найдены .exe после сборки.');
    console.error('Ожидалось в: src-tauri/target/release/bundle/nsis/');
    process.exit(1);
  }
  // GitHub rewrites spaces in asset names to "."; rename before upload so
  // README / release notes URLs match the stored asset (no PDF%20Manager 404).
  artifacts = normalizeArtifactsForGithub(artifacts);

  const setupName = pickSetupArtifact(artifacts, version);
  const portableName = pickPortableArtifact(artifacts);
  const releaseUrl = `https://github.com/${REPO_SLUG}/releases/tag/${tag}`;
  const notes = buildReleaseNotes({
    version,
    tag,
    setupName,
    portableName,
    releaseUrl,
  });

  console.log('Артефакты для загрузки:');
  for (const f of artifacts) console.log('  -', f);
  if (setupName) console.log('Установщик (для README):', toGithubAssetName(setupName));
  if (portableName) console.log('Portable (для README):', toGithubAssetName(portableName));

  // Write notes to a temp file so multiline / Cyrillic stay intact for gh.
  const notesPath = join(root, '.windows-release-notes.tmp.md');
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
          // Do not steal /releases/latest from HTML build-* tags.
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
        [
          'release',
          'edit',
          tag,
          '--title',
          title,
          '--notes-file',
          notesPath,
          '--latest=false',
        ],
        { stdio: 'inherit' },
      );
    }
  } finally {
    try {
      if (existsSync(notesPath)) unlinkSync(notesPath);
    } catch { /* ignore */ }
  }

  // Belt-and-suspenders: after any Windows publish, re-pin Latest to HTML.
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

  pruneStaleSetupAssets(ghBin, tag, version, [setupName, portableName]);

  // Refresh About update-check feed with the new Windows version.
  // Files are written locally; we commit them together with README/index below
  // (do not SKIP_COMMIT here — otherwise main keeps an old windowsVersion).
  console.log('Обновляю version-feed (Windows)…');
  const feed = spawnSync(
    process.platform === 'win32' ? 'node.exe' : 'node',
    [join(root, 'scripts', 'publish-version-feed.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        WINDOWS_VERSION: version,
        WINDOWS_DOWNLOAD_URL: finalReleaseUrl,
        SKIP_COMMIT: '1',
      },
      stdio: 'inherit',
    },
  );
  if (feed.status !== 0) {
    console.warn('version-feed обновить не удалось (установщик уже загружен).');
  }

  // Keep GitHub README / landing / repo description in sync with this Windows build.
  updateReadmeWindowsLinks({
    version,
    tag,
    setupName,
    portableName,
  });
  updateIndexWindowsLinks({
    version,
    tag,
    setupName,
    portableName,
  });
  commitAndPushReleaseMeta(version, tag, [
    join(root, 'README.md'),
    join(root, 'index.html'),
    join(root, 'version.json'),
    join(root, 'version-feed.js'),
  ]);
  updateRepoDescription(ghBin, version, tag);
}

main();

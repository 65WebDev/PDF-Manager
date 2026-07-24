#!/usr/bin/env node
/**
 * Uploads the Windows NSIS installer (and portable .exe) to a GitHub Release.
 *
 * Invoked automatically after `npm run tauri:build` unless:
 *   TAURI_SKIP_UPLOAD=1
 *
 * Requirements:
 *   - GitHub CLI (`gh`) installed and authenticated (`gh auth login`)
 *   - Push access to the repository
 *
 * Release tag: windows-v{version} from src-tauri/tauri.conf.json
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function skipUpload() {
  const v = String(process.env.TAURI_SKIP_UPLOAD || '').trim().toLowerCase();
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

function findArtifacts() {
  const nsisDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const releaseDir = join(root, 'src-tauri', 'target', 'release');
  const files = [];

  if (existsSync(nsisDir)) {
    for (const name of readdirSync(nsisDir)) {
      if (name.toLowerCase().endsWith('.exe')) {
        files.push(join(nsisDir, name));
      }
    }
  }

  // Portable binary next to the installer (optional).
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
    const base = f.split(/[/\\]/).pop();
    if (seen.has(base)) continue;
    seen.add(base);
    unique.push(f);
  }
  return unique;
}

function releaseExists(ghBin, tag) {
  const r = runGh(ghBin, ['release', 'view', tag], { stdio: 'ignore' });
  return r.status === 0;
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
  const notes = [
    'Экспериментальный установщик Tauri (локальная сборка).',
    '',
    '- Установщик NSIS регистрирует ассоциацию с `.pdf`',
    '- После установки: ПКМ по PDF → «Открыть с помощью» → PDF Manager',
    '',
    'Не является частью автоматического HTML release pipeline.',
  ].join('\n');

  const artifacts = findArtifacts();
  if (!artifacts.length) {
    console.error('Не найдены .exe после сборки.');
    console.error('Ожидалось в: src-tauri/target/release/bundle/nsis/');
    process.exit(1);
  }

  console.log('Артефакты для загрузки:');
  for (const f of artifacts) console.log('  -', f);

  if (!releaseExists(ghBin, tag)) {
    console.log(`Создаю release ${tag}…`);
    const created = runGh(
      ghBin,
      ['release', 'create', tag, ...artifacts, '--title', title, '--notes', notes],
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

    runGh(ghBin, ['release', 'edit', tag, '--title', title, '--notes', notes], {
      stdio: 'ignore',
    });
  }

  const view = runGh(ghBin, ['release', 'view', tag, '--json', 'url']);
  if (view.status === 0 && view.stdout) {
    try {
      const { url } = JSON.parse(view.stdout);
      console.log('\nГотово:', url);
    } catch {
      console.log('\nГотово. Тег release:', tag);
    }
  } else {
    console.log('\nГотово. Тег release:', tag);
  }
}

main();

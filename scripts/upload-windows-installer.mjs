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

function ghCmd() {
  return process.platform === 'win32' ? 'gh.cmd' : 'gh';
}

function runGh(args, opts = {}) {
  const r = spawnSync(ghCmd(), args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opts,
  });
  return r;
}

function ensureGhAuth() {
  const which = spawnSync(
    process.platform === 'win32' ? 'where.exe' : 'which',
    [process.platform === 'win32' ? 'gh' : 'gh'],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  );
  if (which.status !== 0) {
    console.error('GitHub CLI (gh) не найден. Установите: https://cli.github.com/');
    console.error('Затем: gh auth login');
    process.exit(1);
  }
  const auth = runGh(['auth', 'status']);
  if (auth.status !== 0) {
    console.error('gh не авторизован. Выполните: gh auth login');
    process.exit(1);
  }
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
      // Prefer the product binary; skip build helpers if any.
      files.push(join(releaseDir, name));
    }
  }

  // Deduplicate by basename preference: setup first already from nsis.
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

function releaseExists(tag) {
  const r = runGh(['release', 'view', tag], { stdio: 'ignore' });
  return r.status === 0;
}

function main() {
  if (skipUpload()) {
    console.log('TAURI_SKIP_UPLOAD set — пропускаю загрузку на GitHub.');
    return;
  }

  ensureGhAuth();

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

  if (!releaseExists(tag)) {
    console.log(`Создаю release ${tag}…`);
    const created = runGh([
      'release',
      'create',
      tag,
      ...artifacts,
      '--title',
      title,
      '--notes',
      notes,
    ], { stdio: 'inherit' });
    if (created.status !== 0) process.exit(created.status ?? 1);
  } else {
    console.log(`Release ${tag} уже есть — обновляю файлы (--clobber)…`);
    const uploaded = runGh([
      'release',
      'upload',
      tag,
      ...artifacts,
      '--clobber',
    ], { stdio: 'inherit' });
    if (uploaded.status !== 0) process.exit(uploaded.status ?? 1);

    // Keep title/notes in sync on re-upload.
    runGh(['release', 'edit', tag, '--title', title, '--notes', notes], {
      stdio: 'ignore',
    });
  }

  const view = runGh(['release', 'view', tag, '--json', 'url'], { encoding: 'utf8' });
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

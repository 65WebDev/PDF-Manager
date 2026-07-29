#!/usr/bin/env node
/**
 * Before a Windows release build: if GitHub already has windows-v{current}
 * AND main has new commits since that tag, bump the patch version in
 * tauri.conf.json + Cargo.toml, commit, and push.
 *
 * That way each meaningful rebuild publishes a new windows-v* tag instead of
 * only clobbering assets on the old tag. Feed / README are updated later by
 * upload-windows-installer.mjs.
 *
 * Skip: SKIP_WINDOWS_BUMP=1 or --dry-run (print decision only).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const CONF = join(root, 'src-tauri', 'tauri.conf.json');
const CARGO = join(root, 'src-tauri', 'Cargo.toml');

function envFlag(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  });
}

function resolveGhBin() {
  if (process.platform === 'win32') {
    const where = run('where.exe', ['gh']);
    const lines = (where.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const exe = lines.find((p) => /\.exe$/i.test(p));
    return exe || lines[0] || null;
  }
  const which = run('which', ['gh']);
  const path = (which.stdout || '').trim();
  return which.status === 0 && path ? path : null;
}

function readVersion() {
  const conf = JSON.parse(readFileSync(CONF, 'utf8'));
  return String(conf.version || '').trim();
}

function bumpPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(String(version).trim());
  if (!m) {
    throw new Error(`Cannot parse semver patch from version: ${version}`);
  }
  const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}${m[4] || ''}`;
  return next;
}

function writeVersions(next) {
  const conf = JSON.parse(readFileSync(CONF, 'utf8'));
  conf.version = next;
  writeFileSync(CONF, `${JSON.stringify(conf, null, 2)}\n`, 'utf8');

  let cargo = readFileSync(CARGO, 'utf8');
  const replaced = cargo.replace(
    /^version\s*=\s*"[^"]+"/m,
    `version = "${next}"`,
  );
  if (replaced === cargo) {
    throw new Error('Cargo.toml version line not found / not updated');
  }
  writeFileSync(CARGO, replaced, 'utf8');
}

function releaseExists(ghBin, tag) {
  const r = run(ghBin, ['release', 'view', tag], { stdio: 'ignore' });
  return r.status === 0;
}

function gitConfigValue(key) {
  const r = run('git', ['config', '--get', key]);
  if (r.status !== 0) return '';
  return String(r.stdout || '').trim();
}

/** Prefer existing git identity; else gh login; else a fixed build bot. */
function resolveCommitIdentity(ghBin) {
  let name = gitConfigValue('user.name');
  let email = gitConfigValue('user.email');
  if (name && email) return { name, email, source: 'git config' };

  if (ghBin) {
    const api = run(ghBin, ['api', 'user', '--jq', '.login']);
    const login = String(api.stdout || '').trim();
    if (api.status === 0 && login) {
      if (!name) name = login;
      if (!email) email = `${login}@users.noreply.github.com`;
      return { name, email, source: `gh:${login}` };
    }
  }

  return {
    name: name || 'PDF Manager Build',
    email: email || 'pdf-manager-build@users.noreply.github.com',
    source: 'fallback',
  };
}

function commitsSinceTag(tag) {
  // Ensure the tag object is available locally for rev-list.
  run('git', ['fetch', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], {
    stdio: 'ignore',
  });
  const r = run('git', ['rev-list', '--count', `${tag}..HEAD`]);
  if (r.status !== 0) {
    // Tag missing locally / history odd — treat as "changed" so we bump.
    console.warn(`WARN: cannot count commits since ${tag}; assuming changes.`);
    if (r.stderr) console.warn(r.stderr.trim());
    return 1;
  }
  return Number((r.stdout || '').trim() || '0') || 0;
}

function main() {
  const dryRun = process.argv.includes('--dry-run') || envFlag('DRY_RUN');
  if (envFlag('SKIP_WINDOWS_BUMP')) {
    console.log('Windows version bump skipped (SKIP_WINDOWS_BUMP=1).');
    return;
  }

  const current = readVersion();
  if (!current) {
    console.error('ERR: empty version in src-tauri/tauri.conf.json');
    process.exit(1);
  }
  const tag = `windows-v${current}`;
  console.log(`Current Windows version: ${current} (tag ${tag})`);

  const ghBin = resolveGhBin();
  if (!ghBin) {
    console.error('ERR: gh not found — needed to check existing Windows releases.');
    console.error('Install GitHub CLI or set SKIP_WINDOWS_BUMP=1');
    process.exit(1);
  }

  if (!releaseExists(ghBin, tag)) {
    console.log(`No GitHub release ${tag} yet — keeping version ${current}.`);
    return;
  }

  const ahead = commitsSinceTag(tag);
  console.log(`Commits on HEAD since ${tag}: ${ahead}`);
  if (ahead <= 0) {
    console.log(
      `No code changes since ${tag} — keeping ${current} (upload may refresh assets on the same tag).`,
    );
    return;
  }

  const next = bumpPatch(current);
  console.log(
    `Tool changed since last Windows release → bump ${current} → ${next}`,
  );

  if (dryRun) {
    console.log('Dry-run: not writing files / not committing.');
    return;
  }

  writeVersions(next);

  const add = run('git', [
    'add',
    '--',
    'src-tauri/tauri.conf.json',
    'src-tauri/Cargo.toml',
  ]);
  if (add.status !== 0) {
    console.error(add.stderr || 'git add failed');
    process.exit(add.status || 1);
  }

  const id = resolveCommitIdentity(ghBin);
  console.log(`Git commit identity: ${id.name} <${id.email}> (${id.source})`);
  const commit = run('git', [
    '-c',
    `user.name=${id.name}`,
    '-c',
    `user.email=${id.email}`,
    'commit',
    '-m',
    `chore: bump Windows version to ${next}`,
  ]);
  if (commit.status !== 0) {
    console.error(commit.stderr || commit.stdout || 'git commit failed');
    process.exit(commit.status || 1);
  }

  // Race: version-feed / other bots often push to main while we build.
  // Rebase onto origin/main and retry push instead of failing the whole build.
  const maxAttempts = 4;
  let pushed = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const push = run('git', ['push', 'origin', 'HEAD']);
    if (push.status === 0) {
      pushed = true;
      break;
    }
    const errText = `${push.stderr || ''}\n${push.stdout || ''}`.trim();
    console.warn(
      `WARN: git push rejected (attempt ${attempt}/${maxAttempts}).`,
    );
    if (errText) console.warn(errText);

    if (attempt === maxAttempts) break;

    console.log('Fetching origin/main and rebasing bump commit…');
    const fetch = run('git', ['fetch', 'origin', 'main']);
    if (fetch.status !== 0) {
      console.error(fetch.stderr || fetch.stdout || 'git fetch failed');
      process.exit(fetch.status || 1);
    }
    const rebase = run('git', [
      '-c',
      `user.name=${id.name}`,
      '-c',
      `user.email=${id.email}`,
      'rebase',
      'origin/main',
    ]);
    if (rebase.status !== 0) {
      console.error(rebase.stderr || rebase.stdout || 'git rebase failed');
      run('git', ['rebase', '--abort'], { stdio: 'ignore' });
      console.error(
        'Could not rebase the Windows version bump onto origin/main.',
      );
      console.error(
        'Fix manually: git pull --rebase origin main && git push origin HEAD',
      );
      console.error('Or discard the local bump and rebuild with -Force.');
      process.exit(rebase.status || 1);
    }
  }

  if (!pushed) {
    console.error('ERR: git push failed after rebase retries.');
    console.error('Version bump commit exists locally but is not on origin/main.');
    console.error(
      'Fix manually: git pull --rebase origin main && git push origin HEAD',
    );
    console.error('Or discard and rebuild: .\\scripts\\build-windows-exe.ps1 -Force');
    process.exit(1);
  }

  console.log(`OK  Bumped and pushed Windows version ${next} (will release as windows-v${next}).`);
}

try {
  main();
} catch (e) {
  console.error('ERR', e && e.message ? e.message : e);
  process.exit(1);
}

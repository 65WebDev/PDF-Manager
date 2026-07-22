#!/usr/bin/env node
/**
 * Prepares the static UI folder consumed by the Tauri shell:
 * 1) builds PDF_manager_offline.html (all libs inlined)
 * 2) copies it to tauri-ui/index.html
 * 3) appends a small bridge so OS "Open with" / file association can load PDFs
 *
 * Not part of the GitHub Release pipeline yet — local / manual Windows builds only.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const offlineHtml = join(root, 'PDF_manager_offline.html');
const uiDir = join(root, 'tauri-ui');
const uiIndex = join(uiDir, 'index.html');

/** Injected only into the Tauri UI copy — never into the browser HTML releases. */
const TAURI_OPEN_BRIDGE = `
<script>
/* Tauri desktop bridge: open PDFs passed via file association / second instance */
(function () {
  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  function waitFor(pred, tries, ms) {
    return new Promise(function (resolve) {
      var n = 0;
      (function tick() {
        if (pred()) return resolve(true);
        if (++n >= tries) return resolve(false);
        setTimeout(tick, ms);
      })();
    });
  }

  function toUint8(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (Array.isArray(data)) return new Uint8Array(data);
    return new Uint8Array(0);
  }

  function basename(path) {
    var parts = String(path).split(/[/\\\\]/);
    return parts[parts.length - 1] || 'document.pdf';
  }

  async function openPaths(paths, invoke) {
    if (!paths || !paths.length) return;
    var pdfs = paths.filter(function (p) {
      return /\\.pdf$/i.test(String(p || ''));
    });
    if (!pdfs.length) return;

    var ok = await waitFor(function () {
      return typeof window.loadPDF === 'function'
        || typeof window.pmOpenFilesAsTabs === 'function'
        || typeof window.openMultipleAsNewDocument === 'function';
    }, 400, 50);
    if (!ok) {
      console.error('[Tauri] loadPDF not ready — cannot open associated PDF');
      return;
    }

    var files = [];
    for (var i = 0; i < pdfs.length; i++) {
      var path = pdfs[i];
      try {
        var bytes = toUint8(await invoke('read_local_file', { path: path }));
        files.push(new File([bytes], basename(path), { type: 'application/pdf' }));
      } catch (err) {
        console.error('[Tauri] failed to read', path, err);
        alert('Не удалось открыть файл:\\n' + path + '\\n\\n' + (err && err.message ? err.message : err));
      }
    }
    if (!files.length) return;

    try {
      if (typeof window.pmTabsEnabled === 'function' && window.pmTabsEnabled()
          && typeof window.pmOpenFilesAsTabs === 'function') {
        await window.pmOpenFilesAsTabs(files, null);
      } else if (files.length === 1 && typeof window.loadPDF === 'function') {
        await window.loadPDF(files[0]);
      } else if (typeof window.openMultipleAsNewDocument === 'function') {
        await window.openMultipleAsNewDocument(files);
      } else if (typeof window.loadPDF === 'function') {
        await window.loadPDF(files[0]);
      }
    } catch (err) {
      console.error('[Tauri] open failed', err);
      alert('Ошибка открытия PDF: ' + (err && err.message ? err.message : err));
    }
  }

  ready(async function () {
    var tauri = window.__TAURI__;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') return;
    var invoke = tauri.core.invoke.bind(tauri.core);

    try {
      var pending = await invoke('take_pending_open_files');
      await openPaths(pending, invoke);
    } catch (err) {
      console.error('[Tauri] take_pending_open_files', err);
    }

    if (tauri.event && typeof tauri.event.listen === 'function') {
      try {
        await tauri.event.listen('open-files', function (event) {
          openPaths(event && event.payload, invoke);
        });
      } catch (err) {
        console.error('[Tauri] listen open-files', err);
      }
    }
  });
})();
</script>
`;

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
let html = readFileSync(offlineHtml, 'utf8');
if (!html.includes('Tauri desktop bridge')) {
  // Insert before the document's final </html>. Never use a global
  // String.replace(/<\/body>/) — inlined libs (SheetJS) embed that text.
  const closeHtml = html.lastIndexOf('</html>');
  if (closeHtml !== -1) {
    html =
      html.slice(0, closeHtml) +
      `${TAURI_OPEN_BRIDGE}\n` +
      html.slice(closeHtml);
  } else {
    html += TAURI_OPEN_BRIDGE;
  }
}
writeFileSync(uiIndex, html, 'utf8');
console.log('Wrote', uiIndex, '(with file-association bridge)');

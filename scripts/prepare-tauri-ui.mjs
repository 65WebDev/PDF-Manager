#!/usr/bin/env node
/**
 * Prepares the static UI folder consumed by the Tauri shell:
 * 1) builds PDF_manager_offline.html (all libs inlined)
 * 2) copies it to tauri-ui/index.html
 * 3) appends a small bridge so OS "Open with" / file association / Explorer
 *    drag-and-drop can load PDFs
 *
 * Not part of the GitHub Release pipeline yet — local / manual Windows builds only.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
/* Tauri desktop bridge: Open-with, second instance, Explorer drag-and-drop */
(function () {
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
    if (ArrayBuffer.isView && ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (Array.isArray(data)) return new Uint8Array(data);
    return new Uint8Array(0);
  }

  function basename(path) {
    var parts = String(path).split(/[/\\\\]/);
    return parts[parts.length - 1] || 'document.pdf';
  }

  function getGlobalFn(name) {
    try {
      if (typeof window[name] === 'function') return window[name];
    } catch (_) {}
    try {
      // Classic <script> globals (not always mirrored on window in all hosts).
      // eslint-disable-next-line no-eval
      var v = (0, eval)('typeof ' + name + ' === "function" ? ' + name + ' : null');
      if (typeof v === 'function') return v;
    } catch (_) {}
    return null;
  }

  function getLoader() {
    return getGlobalFn('loadPDF');
  }

  // Tauri drag-drop positions are PhysicalPosition (screen pixels). DOM APIs
  // (clientX / getBoundingClientRect) use CSS logical pixels. On Windows DPI
  // scaling (125%/150%/…) raw physical coords look “shifted” down-right.
  var dragScaleFactor = (typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0)
    ? window.devicePixelRatio
    : 1;

  async function refreshDragScaleFactor() {
    try {
      var winApi = window.__TAURI__ && window.__TAURI__.window;
      var getWin = winApi && (winApi.getCurrentWindow || (winApi.Window && winApi.Window.getCurrent));
      if (typeof getWin === 'function') {
        var win = getWin.call(winApi);
        if (win && typeof win.scaleFactor === 'function') {
          var sf = await win.scaleFactor();
          if (typeof sf === 'number' && sf > 0) {
            dragScaleFactor = sf;
            return;
          }
        }
      }
    } catch (_) {}
    if (typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0) {
      dragScaleFactor = window.devicePixelRatio;
    }
  }

  /** Map Tauri PhysicalPosition → CSS viewport client coordinates. */
  function mapDragPos(position) {
    if (!position || typeof position.x !== 'number' || typeof position.y !== 'number') return null;
    var scale = dragScaleFactor > 0 ? dragScaleFactor : 1;
    return { x: position.x / scale, y: position.y / scale };
  }

  function endOsDragUi() {
    try {
      document.body.classList.remove('os-file-dragging', 'os-file-drag-active');
      var clearIns = getGlobalFn('clearInsertIndicators');
      var hideIns = getGlobalFn('hideInsertIndicator');
      var hint = getGlobalFn('pmShowTabDropHint');
      var ghosts = getGlobalFn('pmClearFileDragGhosts');
      if (clearIns) clearIns();
      if (hideIns) hideIns();
      if (hint) hint(false);
      if (ghosts) ghosts();
    } catch (_) {}
  }

  function onOsDragHover(position) {
    try {
      document.body.classList.add('os-file-dragging');
      var pos = mapDragPos(position);
      if (!pos) return;
      var x = pos.x, y = pos.y;
      var update = getGlobalFn('updateInsertIndicatorsAt');
      if (typeof pdfDoc !== 'undefined' && pdfDoc && update) {
        update(x, y);
        var willInsert = !!(document.getElementById('pagesContainer')
          && document.querySelector('#pagesContainer .insert-before, #pagesContainer .insert-after'));
        var hint = getGlobalFn('pmShowTabDropHint');
        if (hint) hint(!willInsert, x, y, null);
      } else {
        var hintEmpty = getGlobalFn('pmShowTabDropHint');
        if (hintEmpty) hintEmpty(true, x, y, null);
      }
    } catch (err) {
      console.warn('[Tauri] drag hover UI', err);
    }
  }

  async function pathsToFiles(paths, invoke) {
    var pdfs = (paths || []).filter(function (p) {
      return /\\.pdf$/i.test(String(p || ''));
    });
    if (!pdfs.length) {
      console.warn('[Tauri] no .pdf paths in', paths);
      return [];
    }
    var files = [];
    for (var i = 0; i < pdfs.length; i++) {
      var path = pdfs[i];
      try {
        var raw = await invoke('read_local_file', { path: path });
        var bytes = toUint8(raw);
        if (!bytes.length) throw new Error('пустой файл');
        files.push(new File([bytes], basename(path), { type: 'application/pdf' }));
      } catch (err) {
        console.error('[Tauri] failed to read', path, err);
        alert('Не удалось открыть файл:\\n' + path + '\\n\\n' + (err && err.message ? err.message : err));
      }
    }
    return files;
  }

  async function openFiles(files) {
    if (!files || !files.length) return;
    var loader = getLoader();
    var tabsEnabled = getGlobalFn('pmTabsEnabled');
    var openTabs = getGlobalFn('pmOpenFilesAsTabs');
    var openMulti = getGlobalFn('openMultipleAsNewDocument');
    try {
      if (tabsEnabled && tabsEnabled() && openTabs) {
        await openTabs(files, null);
      } else if (files.length === 1 && loader) {
        await loader(files[0]);
      } else if (openMulti) {
        await openMulti(files);
      } else if (loader) {
        await loader(files[0]);
      } else {
        throw new Error('loadPDF not available');
      }
    } catch (err) {
      console.error('[Tauri] open failed', err);
      alert('Ошибка открытия PDF: ' + (err && err.message ? err.message : err));
    }
  }

  async function openPaths(paths, invoke, position) {
    if (!paths || !paths.length) return;
    var ok = await waitFor(function () { return !!getLoader(); }, 600, 50);
    if (!ok) {
      console.error('[Tauri] loadPDF not ready — cannot open associated PDF');
      alert('Не удалось открыть PDF: редактор ещё не готов.');
      endOsDragUi();
      return;
    }

    var files = await pathsToFiles(paths, invoke);
    if (!files.length) {
      endOsDragUi();
      return;
    }

    // Drop onto an open document: prefer insert-at-gap when markers exist.
    try {
      var hasDoc = typeof pdfDoc !== 'undefined' && !!pdfDoc;
      var update = getGlobalFn('updateInsertIndicatorsAt');
      var insertAt = getGlobalFn('insertFilesAtPosition');
      var pagesEl = document.getElementById('pagesContainer');
      var clientPos = mapDragPos(position);
      if (hasDoc && clientPos && update && insertAt && pagesEl) {
        update(clientPos.x, clientPos.y);
        var beforeEl = pagesEl.querySelector('.insert-before');
        var afterEl = pagesEl.querySelector('.insert-after');
        var insert = null;
        if (beforeEl) {
          insert = { targetIndex: parseInt(beforeEl.dataset.index, 10), insertBefore: true };
        } else if (afterEl) {
          insert = { targetIndex: parseInt(afterEl.dataset.index, 10), insertBefore: false };
        }
        endOsDragUi();
        if (insert && !Number.isNaN(insert.targetIndex)) {
          if (files.length > 1 && typeof showMergeOrderModal === 'function') {
            showMergeOrderModal(files, async function (ordered) {
              await insertAt(ordered, insert);
            });
          } else {
            await insertAt(files, insert);
          }
          return;
        }
      }
    } catch (err) {
      console.warn('[Tauri] insert-at-drop fallback to open', err);
    }

    endOsDragUi();
    await openFiles(files);
  }

  async function bindDragDrop(invoke) {
    var tauri = window.__TAURI__;
    var webviewApi = tauri && tauri.webview;
    var getCurrent = webviewApi && (
      webviewApi.getCurrentWebview ||
      (webviewApi.Webview && webviewApi.Webview.getCurrent)
    );
    if (typeof getCurrent !== 'function') {
      console.warn('[Tauri] getCurrentWebview unavailable — Explorer DnD bridge skipped');
      return;
    }
    try {
      var webview = getCurrent.call(webviewApi);
      if (!webview || typeof webview.onDragDropEvent !== 'function') {
        console.warn('[Tauri] onDragDropEvent unavailable');
        return;
      }
      await webview.onDragDropEvent(function (event) {
        var payload = event && event.payload;
        if (!payload || !payload.type) return;
        if (payload.type === 'enter' || payload.type === 'over') {
          // Refresh DPI on enter in case the window moved between monitors.
          if (payload.type === 'enter') refreshDragScaleFactor();
          onOsDragHover(payload.position);
          return;
        }
        if (payload.type === 'leave' || payload.type === 'cancel') {
          endOsDragUi();
          return;
        }
        if (payload.type === 'drop') {
          console.log('[Tauri] drag-drop paths:', payload.paths, 'scale=', dragScaleFactor);
          openPaths(payload.paths, invoke, payload.position);
        }
      });
      console.log('[Tauri] Explorer drag-and-drop bridge ready (scaleFactor=' + dragScaleFactor + ')');
    } catch (err) {
      console.error('[Tauri] bindDragDrop', err);
    }
  }

  async function boot() {
    var ready = await waitFor(function () {
      return !!(window.__TAURI__ && window.__TAURI__.core
        && typeof window.__TAURI__.core.invoke === 'function');
    }, 200, 50);
    if (!ready) {
      console.error('[Tauri] __TAURI__ API not available');
      return;
    }

    var tauri = window.__TAURI__;
    var invoke = tauri.core.invoke.bind(tauri.core);

    await refreshDragScaleFactor();
    try {
      var winApi = tauri.window;
      var getWin = winApi && (winApi.getCurrentWindow || (winApi.Window && winApi.Window.getCurrent));
      if (typeof getWin === 'function') {
        var win = getWin.call(winApi);
        if (win && typeof win.onScaleChanged === 'function') {
          win.onScaleChanged(function () { refreshDragScaleFactor(); });
        }
      }
    } catch (_) {}

    try {
      var pending = await invoke('take_pending_open_files');
      console.log('[Tauri] pending open files:', pending);
      await openPaths(pending, invoke, null);
    } catch (err) {
      console.error('[Tauri] take_pending_open_files', err);
    }

    if (tauri.event && typeof tauri.event.listen === 'function') {
      try {
        await tauri.event.listen('open-files', function (event) {
          console.log('[Tauri] open-files event:', event && event.payload);
          openPaths(event && event.payload, invoke, null);
        });
      } catch (err) {
        console.error('[Tauri] listen open-files', err);
      }
    }

    await bindDragDrop(invoke);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
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
console.log('Wrote', uiIndex, '(with file-association + Explorer DnD bridge)');

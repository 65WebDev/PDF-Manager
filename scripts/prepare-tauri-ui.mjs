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

  // Paths arrive on enter/drop only (not on over) — keep count for hover UI.
  var osDragPdfCount = 0;
  var TAB_HOVER_ACTIVATE_MS = 500;
  var tabHoverActivateId = null;
  var tabHoverActivateTimer = null;
  var tabInsertIndex = null;

  function countPdfPaths(paths) {
    return (paths || []).filter(function (p) {
      return /\\.pdf$/i.test(String(p || ''));
    }).length;
  }

  function pointInRect(x, y, r) {
    return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function clearTabHoverActivate() {
    if (tabHoverActivateTimer) {
      clearTimeout(tabHoverActivateTimer);
      tabHoverActivateTimer = null;
    }
    if (tabHoverActivateId != null) {
      var tabBar = document.getElementById('tabBar');
      var el = tabBar && tabBar.querySelector('.pm-tab[data-tab-id="' + tabHoverActivateId + '"]');
      if (el) el.classList.remove('pm-tab-hover-activate', 'pm-tab-hover-activate-run');
      tabHoverActivateId = null;
    }
  }

  /** Mirror of pmComputeTabDragZone (HTML5 tab-bar DnD). */
  function computeTabDragZone(clientX) {
    var tabBar = document.getElementById('tabBar');
    if (!tabBar) return { type: 'insert', index: 0 };
    var tabs = Array.prototype.slice.call(tabBar.querySelectorAll('.pm-tab'));
    if (!tabs.length) return { type: 'insert', index: 0 };
    for (var i = 0; i < tabs.length; i++) {
      var r = tabs[i].getBoundingClientRect();
      if (clientX < r.left) return { type: 'insert', index: i };
      if (clientX <= r.right) {
        var frac = r.width ? (clientX - r.left) / r.width : 0.5;
        if (frac < 1 / 3) return { type: 'insert', index: i };
        if (frac > 2 / 3) return { type: 'insert', index: i + 1 };
        return { type: 'activate', tabId: parseInt(tabs[i].dataset.tabId, 10) };
      }
    }
    return { type: 'insert', index: tabs.length };
  }

  function clearPageInsertUi() {
    var clearIns = getGlobalFn('clearInsertIndicators');
    var hideIns = getGlobalFn('hideInsertIndicator');
    if (clearIns) clearIns();
    if (hideIns) hideIns();
  }

  function endOsDragUi() {
    try {
      document.body.classList.remove(
        'os-file-dragging',
        'os-file-drag-active',
        'pm-tab-file-drag'
      );
      clearPageInsertUi();
      clearTabHoverActivate();
      tabInsertIndex = null;
      osDragPdfCount = 0;
      var hideTabInd = getGlobalFn('pmHideTabInsertIndicator');
      var hint = getGlobalFn('pmShowTabDropHint');
      var mergeHint = getGlobalFn('pmShowMergeBtnDropHint');
      var ghosts = getGlobalFn('pmClearFileDragGhosts');
      if (hideTabInd) hideTabInd();
      if (hint) hint(false);
      if (mergeHint) mergeHint(false);
      if (ghosts) ghosts();
      var mergeBtn = document.getElementById('mergeBtn');
      if (mergeBtn) mergeBtn.classList.remove('merge-drop-active');
    } catch (_) {}
  }

  function onOsDragHover(position) {
    try {
      document.body.classList.add('os-file-dragging');
      var pos = mapDragPos(position);
      if (!pos) return;
      var x = pos.x, y = pos.y;

      // Open “merge order” modal owns OS-file hover/drop (Tauri native DnD).
      var mergeOrderTarget = null;
      try { mergeOrderTarget = window.__pmMergeOrderOsTarget; } catch (_) {}
      if (mergeOrderTarget && typeof mergeOrderTarget.onHover === 'function') {
        clearPageInsertUi();
        clearTabHoverActivate();
        tabInsertIndex = null;
        var hideTabInd = getGlobalFn('pmHideTabInsertIndicator');
        var tabHint = getGlobalFn('pmShowTabDropHint');
        var mergeHint = getGlobalFn('pmShowMergeBtnDropHint');
        var clearGhosts = getGlobalFn('pmClearFileDragGhosts');
        if (hideTabInd) hideTabInd();
        if (tabHint) tabHint(false);
        if (mergeHint) mergeHint(false);
        if (clearGhosts) clearGhosts();
        document.body.classList.remove('os-file-drag-active', 'pm-tab-file-drag');
        var mergeBtn = document.getElementById('mergeBtn');
        if (mergeBtn) mergeBtn.classList.remove('merge-drop-active');
        mergeOrderTarget.onHover(x, y);
        return;
      }

      var n = osDragPdfCount;
      var tabsOn = !!(getGlobalFn('pmTabsEnabled') && getGlobalFn('pmTabsEnabled')());
      var tabBar = document.getElementById('tabBar');
      var mergeBtn = document.getElementById('mergeBtn');
      var ghosts = getGlobalFn('pmShowFileDragGhosts');
      var clearGhosts = getGlobalFn('pmClearFileDragGhosts');
      var tabHint = getGlobalFn('pmShowTabDropHint');
      var mergeHint = getGlobalFn('pmShowMergeBtnDropHint');
      var showTabInd = getGlobalFn('pmShowTabInsertIndicator');
      var hideTabInd = getGlobalFn('pmHideTabInsertIndicator');
      var update = getGlobalFn('updateInsertIndicatorsAt');

      // ── Merge button (2+ PDFs) ──────────────────────────────────────
      if (mergeBtn && n >= 2 && pointInRect(x, y, mergeBtn.getBoundingClientRect())) {
        clearPageInsertUi();
        clearTabHoverActivate();
        tabInsertIndex = null;
        if (hideTabInd) hideTabInd();
        if (tabHint) tabHint(false);
        document.body.classList.add('os-file-drag-active');
        mergeBtn.classList.add('merge-drop-active');
        if (mergeHint) mergeHint(true, x, y);
        // Merge always creates exactly one new tab → one ghost.
        if (ghosts) ghosts(1);
        return;
      }
      if (mergeBtn) mergeBtn.classList.remove('merge-drop-active');
      if (mergeHint) mergeHint(false);

      // Soft outline on Merge while multi-file drag is anywhere in the window.
      if (n >= 2) document.body.classList.add('os-file-drag-active');
      else document.body.classList.remove('os-file-drag-active');

      // ── Tab bar: ghosts / insert separator / mid-tab activate ───────
      var tabBarVisible = !!(tabBar && tabsOn && tabBar.style.display !== 'none'
        && tabBar.querySelectorAll('.pm-tab').length);
      if (tabBarVisible && pointInRect(x, y, tabBar.getBoundingClientRect())) {
        clearPageInsertUi();
        if (tabHint) tabHint(false);
        document.body.classList.add('pm-tab-file-drag');
        var zone = computeTabDragZone(x);
        var tabCount = tabBar.querySelectorAll('.pm-tab').length;

        if (zone.type === 'activate') {
          tabInsertIndex = null;
          if (hideTabInd) hideTabInd();
          if (clearGhosts) clearGhosts();
          var activeEl = tabBar.querySelector('.pm-tab.active');
          var activeId = activeEl ? parseInt(activeEl.dataset.tabId, 10) : null;
          if (zone.tabId === activeId) {
            clearTabHoverActivate();
            return;
          }
          if (tabHoverActivateId !== zone.tabId) {
            clearTabHoverActivate();
            tabHoverActivateId = zone.tabId;
            var el = tabBar.querySelector('.pm-tab[data-tab-id="' + zone.tabId + '"]');
            if (el) {
              el.classList.add('pm-tab-hover-activate');
              requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                  if (el.isConnected && tabHoverActivateId === zone.tabId) {
                    el.classList.add('pm-tab-hover-activate-run');
                  }
                });
              });
            }
            var targetId = zone.tabId;
            var activate = getGlobalFn('pmActivate');
            tabHoverActivateTimer = setTimeout(function () {
              tabHoverActivateTimer = null;
              if (activate) activate(targetId);
              clearTabHoverActivate();
            }, TAB_HOVER_ACTIVATE_MS);
          }
          return;
        }

        clearTabHoverActivate();
        tabInsertIndex = zone.index;
        var atEnd = tabInsertIndex === tabCount;
        // Don't call pmHideTabInsertIndicator() for atEnd — it also clears
        // pm-tab-file-drag / insert index used by the HTML5 path.
        if (atEnd) {
          var indEl = document.getElementById('pmTabInsertIndicator');
          if (indEl) indEl.style.display = 'none';
        } else if (showTabInd) {
          showTabInd(tabInsertIndex);
        }
        document.body.classList.add('pm-tab-file-drag');
        if (ghosts) ghosts(atEnd ? n : 0);
        return;
      }

      // Left the tab bar — clear tab-only chrome.
      clearTabHoverActivate();
      tabInsertIndex = null;
      if (hideTabInd) hideTabInd();
      if (clearGhosts) clearGhosts();
      document.body.classList.remove('pm-tab-file-drag');

      // ── Page gaps / empty workspace hints ───────────────────────────
      if (typeof pdfDoc !== 'undefined' && pdfDoc && update) {
        update(x, y);
        var willInsert = !!(document.getElementById('pagesContainer')
          && document.querySelector('#pagesContainer .insert-before, #pagesContainer .insert-after'));
        if (tabHint) tabHint(!willInsert, x, y, n);
      } else if (tabHint) {
        tabHint(true, x, y, n);
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

    var clientPos = mapDragPos(position);

    // 0) Open merge-order modal: insert into its list (or swallow if over modal chrome).
    try {
      var mergeOrderTarget = null;
      try { mergeOrderTarget = window.__pmMergeOrderOsTarget; } catch (_) {}
      if (mergeOrderTarget && typeof mergeOrderTarget.onDrop === 'function' && clientPos) {
        endOsDragUi();
        await mergeOrderTarget.onDrop(clientPos.x, clientPos.y, files);
        return;
      }
    } catch (err) {
      console.warn('[Tauri] merge-order-drop fallback', err);
    }

    // 1) Drop on Merge (≥2 files) → merge into a new tab.
    try {
      var mergeBtn = document.getElementById('mergeBtn');
      var mergeFlow = getGlobalFn('mergeFilesFlow');
      if (
        clientPos && mergeBtn && mergeFlow && files.length >= 2 &&
        pointInRect(clientPos.x, clientPos.y, mergeBtn.getBoundingClientRect())
      ) {
        endOsDragUi();
        await mergeFlow(files, { forceNewTab: true });
        return;
      }
    } catch (err) {
      console.warn('[Tauri] merge-drop fallback', err);
    }

    // 2) Drop on tab bar → open as tabs at insert index.
    try {
      var tabsOn = !!(getGlobalFn('pmTabsEnabled') && getGlobalFn('pmTabsEnabled')());
      var tabBar = document.getElementById('tabBar');
      var openDropped = getGlobalFn('pmOpenDroppedFilesAsTabs');
      var openTabs = getGlobalFn('pmOpenFilesAsTabs');
      var computeInsert = getGlobalFn('pmComputeTabInsertIndex');
      if (
        clientPos && tabsOn && tabBar && tabBar.style.display !== 'none' &&
        tabBar.querySelectorAll('.pm-tab').length &&
        pointInRect(clientPos.x, clientPos.y, tabBar.getBoundingClientRect())
      ) {
        var insertIdx = tabInsertIndex != null
          ? tabInsertIndex
          : (computeInsert ? computeInsert(clientPos.x) : null);
        endOsDragUi();
        if (openDropped) {
          await openDropped(files, insertIdx, null, null);
        } else if (openTabs) {
          await openTabs(files, null, insertIdx);
        } else {
          await openFiles(files);
        }
        return;
      }
    } catch (err) {
      console.warn('[Tauri] tab-drop fallback', err);
    }

    // 3) Drop onto an open document: prefer insert-at-gap when markers exist.
    try {
      var hasDoc = typeof pdfDoc !== 'undefined' && !!pdfDoc;
      var update = getGlobalFn('updateInsertIndicatorsAt');
      var insertAt = getGlobalFn('insertFilesAtPosition');
      var pagesEl = document.getElementById('pagesContainer');
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
          // Paths only on enter — keep count for hover (ghosts / merge).
          if (payload.type === 'enter') {
            refreshDragScaleFactor();
            osDragPdfCount = countPdfPaths(payload.paths);
          }
          onOsDragHover(payload.position);
          return;
        }
        if (payload.type === 'leave' || payload.type === 'cancel') {
          try {
            var mot = window.__pmMergeOrderOsTarget;
            if (mot && typeof mot.clear === 'function') mot.clear();
          } catch (_) {}
          endOsDragUi();
          return;
        }
        if (payload.type === 'drop') {
          osDragPdfCount = countPdfPaths(payload.paths);
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

// Stamp Windows shell version into About (empty in browser builds).
let windowsVersion = '';
try {
  const conf = JSON.parse(
    readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  windowsVersion = String(conf.version || '').trim();
} catch (_) { /* ignore */ }
if (windowsVersion) {
  html = html.replace(
    /const PDF_MANAGER_WINDOWS_VERSION = '';/,
    `const PDF_MANAGER_WINDOWS_VERSION = ${JSON.stringify(windowsVersion)};`,
  );
}

// If HTML build placeholders were not stamped by CI, copy numbers from the
// local version feed so About can compare against newer releases.
try {
  const feedPath = join(root, 'version-feed.js');
  if (
    existsSync(feedPath) &&
    html.includes("const PDF_MANAGER_BUILD_VERSION = '__PDF_MANAGER_BUILD__'")
  ) {
    const feedText = readFileSync(feedPath, 'utf8');
    const m = feedText.match(
      /window\.__PDF_MANAGER_VERSION_FEED__\s*=\s*(\{[\s\S]*?\})\s*;/,
    );
    if (m) {
      const feed = JSON.parse(m[1]);
      if (feed.build) {
        html = html.replace(
          /const PDF_MANAGER_BUILD_VERSION = '__PDF_MANAGER_BUILD__';/,
          `const PDF_MANAGER_BUILD_VERSION = ${JSON.stringify(String(feed.build))};`,
        );
      }
      if (feed.date) {
        const dateOnly = String(feed.date).slice(0, 10);
        html = html.replace(
          /const PDF_MANAGER_BUILD_DATE = '__PDF_MANAGER_DATE__';/,
          `const PDF_MANAGER_BUILD_DATE = ${JSON.stringify(dateOnly)};`,
        );
      }
    }
  }
} catch (_) { /* ignore */ }

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
console.log(
  'Wrote',
  uiIndex,
  windowsVersion
    ? `(Windows ${windowsVersion}, file-association + Explorer DnD bridge)`
    : '(with file-association + Explorer DnD bridge)',
);

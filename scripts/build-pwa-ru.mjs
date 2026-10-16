#!/usr/bin/env node
/**
 * Builds the installable web app (PWA) of the Russian-only offline editor
 * into pwa-ru/ - published by the Pages workflow at
 *   https://65WebDev.github.io/PDF-Manager/ru/
 *
 * Reads PDF_manager_offline_ru.html (every library already inlined, see
 * build-offline.mjs / build-offline-ru.mjs) and adds what makes it an app:
 *   - manifest.webmanifest: name, icons, and a file handler for .pdf, so the
 *     installed app shows up in "Open with" and can be the default for PDFs;
 *   - sw.js: a service worker that keeps the page and icons in the browser's
 *     cache - after the first visit the app opens with no network at all.
 *     Each build gets its own cache; a new build is fetched in the
 *     background and takes over on the next launch, without any prompt or
 *     "check for updates" in the app itself;
 *   - the <link rel=manifest> and the service-worker registration (only over
 *     https / localhost - a downloaded copy opened from disk is unaffected).
 * Files the system hands over are opened by the editor itself
 * (window.launchQueue in PDF_manager_online.html).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const inputPath = join(root, 'PDF_manager_offline_ru.html');
const outDir = join(root, 'pwa-ru');
const iconDir = join(root, 'pwa');
const ICONS = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
const THEME = '#2c3e50';

function replaceOnce(html, search, replace, label) {
  const count = html.split(search).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly 1 match, found ${count}`);
  return html.replace(search, replace);
}

const HEAD_TAGS = `
  <!-- Installable app (PWA, scripts/build-pwa-ru.mjs) -->
  <link rel="manifest" href="manifest.webmanifest">
  <meta name="theme-color" content="${THEME}">
  <link rel="icon" type="image/png" sizes="192x192" href="icon-192.png">
  <link rel="apple-touch-icon" href="icon-192.png">
`;

const SW_REGISTER = `
<script>
/* Installable app: keep it working offline (sw.js). Only where a service
   worker can exist - a copy opened from disk simply skips this. */
(function () {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      console.warn('[PWA] service worker not registered', err);
    });
  });
})();
</script>
`;

function manifest() {
  return {
    // Stable and unique on the github.io origin (resolved against it).
    id: 'pdf-manager-offline-ru',
    name: 'Менеджер документов PDF',
    short_name: 'PDF Manager',
    description: 'Офлайн-редактор PDF: просмотр, правка страниц, объединение, сжатие — всё на вашем устройстве.',
    lang: 'ru',
    dir: 'ltr',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: THEME,
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ],
    // "Open with" / default app for .pdf; several files at once go to one
    // window (the editor opens them as tabs).
    file_handlers: [
      {
        action: './',
        accept: { 'application/pdf': ['.pdf'] },
        icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }],
        launch_type: 'single-client'
      }
    ],
    // An already open window takes new files instead of a second window.
    launch_handler: { client_mode: ['focus-existing', 'auto'] }
  };
}

function serviceWorker(version, assets) {
  return `/* Service worker of the installable PDF Manager (offline_ru). Generated
   by scripts/build-pwa-ru.mjs - do not edit by hand. */
const CACHE = 'pdf-manager-ru-${version}';
const ASSETS = ${JSON.stringify(assets)};

// A new build caches itself in the background; it takes over once every
// window of the old one is closed (no skipWaiting), so an open document
// never has the page swapped under it.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('pdf-manager-ru-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Cache first, for this app's own files only; the page is served for any
// navigation inside the scope (e.g. a launch with a query string).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate') {
      const page = await cache.match('./', { ignoreSearch: true }) || await cache.match('index.html');
      if (page) return page;
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return fetch(req);
  })());
});
`;
}

function main() {
  if (!existsSync(inputPath)) {
    throw new Error(`${inputPath} not found - run "npm run build:offline" and "npm run build:offline-ru" first`);
  }
  let html = readFileSync(inputPath, 'utf8');
  // The page's own tags sit on lines of their own; the editor's script also
  // writes "</head>"/"</body>" inside strings (print window), never alone.
  html = replaceOnce(html, '\n</head>\n', '\n' + HEAD_TAGS + '</head>\n', 'head');
  html = replaceOnce(html, '\n</body>', '\n' + SW_REGISTER + '</body>', 'body');

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), html, 'utf8');
  const manifestText = JSON.stringify(manifest(), null, 2) + '\n';
  writeFileSync(join(outDir, 'manifest.webmanifest'), manifestText, 'utf8');
  for (const icon of ICONS) copyFileSync(join(iconDir, icon), join(outDir, icon));

  // The cache name follows the content, so every real change is a new build
  // for the browser and nothing else is.
  const hash = createHash('sha256');
  hash.update(html);
  hash.update(manifestText);
  for (const icon of ICONS) hash.update(readFileSync(join(iconDir, icon)));
  const version = hash.digest('hex').slice(0, 12);
  const assets = ['./', 'index.html', 'manifest.webmanifest', ...ICONS];
  writeFileSync(join(outDir, 'sw.js'), serviceWorker(version, assets), 'utf8');

  const sizeMb = (Buffer.byteLength(html, 'utf8') / (1024 * 1024)).toFixed(2);
  console.log(`Wrote ${outDir} (index.html ${sizeMb} MB, cache ${version})`);
}

main();

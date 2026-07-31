#!/usr/bin/env node
/**
 * Builds PDF_manager_offline.html from PDF_manager_online.html by inlining
 * all external script dependencies so the editor works without internet.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const inputPath = join(root, 'PDF_manager_online.html');
const outputPath = join(root, 'PDF_manager_offline.html');

/** CDN scripts referenced from <head> (order preserved). */
const HEAD_SCRIPTS = [
  {
    comment: 'pdf-lib: PDF assembly/editing (pages, rotations, merging, saving)',
    url: 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js',
  },
  {
    comment: 'pdf.js: render PDF pages to canvas (thumbnails, preview)',
    url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  },
  {
    comment: 'mammoth: Convert DOCX to HTML when importing Word documents',
    url: 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
  },
  {
    comment: 'SheetJS (xlsx): Read XLSX/XLS when importing tables',
    url: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  },
  {
    comment: 'html2canvas: rasterization of HTML markup (Word/Excel pages) into an image for PDF assembly',
    url: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  },
  {
    comment: 'JSZip: DOCX unpacking (this is a zip archive) - needed for docx-preview',
    url: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  },
  {
    comment: 'docx-preview: page-by-page rendering of DOCX to HTML, taking into account Word page breaks',
    url: 'https://cdn.jsdelivr.net/npm/docx-preview@0.3.7/dist/docx-preview.min.js',
  },
  {
    comment: 'ExcelJS: Read XLSX with styles and print options for pagination when converting to PDF',
    url: 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js',
  },
];

const PDFJS_WORKER_URL =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const CANTOO_IMPORT =
  "import('https://esm.sh/@cantoo/pdf-lib@2.7.4')";

const POSTAL_MIME_IMPORT =
  "import('https://cdn.jsdelivr.net/npm/postal-mime@2.7.5/+esm')";

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function escapeForInlineScript(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

function wrapInlineScript(code, comment) {
  const safe = escapeForInlineScript(code);
  const note = comment ? `<!--${comment}-->\n  ` : '';
  return `${note}<script>\n${safe}\n</script>`;
}

function toBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function bundleCantooPdfLib() {
  const result = await esbuild.build({
    entryPoints: [join(root, 'node_modules/@cantoo/pdf-lib/es/index.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    minify: true,
    target: ['es2020'],
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

function replaceHeadScripts(html, inlinedBlocks) {
  let out = html;
  for (const spec of HEAD_SCRIPTS) {
    const pattern = new RegExp(
      `\\s*<!--${escapeRegExp(spec.comment)}-->\\s*\\n\\s*<script src="${escapeRegExp(spec.url)}"><\\/script>`,
      'm',
    );
    const block = inlinedBlocks.get(spec.url);
    if (!pattern.test(out)) {
      throw new Error(`Could not find script tag for ${spec.url}`);
    }
    // Use a callback so "$&", "$'", etc. in minified library code are not treated
    // as String.replace substitution patterns.
    out = out.replace(pattern, () => `\n  ${block}`);
  }
  return out;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replacePdfJsWorker(html, workerCode) {
  const workerB64 = toBase64(workerCode);
  const replacement = [
    '//Worker pdf.js - PDF rendering runs in a separate thread without blocking the interface',
    '(function () {',
    `  var workerB64 = '${workerB64}';`,
    "  var binary = atob(workerB64);",
    '  var bytes = new Uint8Array(binary.length);',
    '  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);',
    "  var blob = new Blob([bytes], { type: 'application/javascript' });",
    '  pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);',
    '})();',
  ].join('\n    ');

  const pattern = new RegExp(
    [
      '//Worker pdf\\.js - PDF rendering runs in a separate thread without blocking the interface',
      "\\s*pdfjsLib\\.GlobalWorkerOptions\\.workerSrc = '",
      escapeRegExp(PDFJS_WORKER_URL),
      "';",
    ].join('\\s*'),
    'm',
  );

  if (!pattern.test(html)) {
    throw new Error('Could not find pdf.js workerSrc assignment');
  }
  return html.replace(pattern, replacement);
}

function replaceCantooImport(html, bundledEsm) {
  const moduleB64 = toBase64(bundledEsm);
  const replacement = [
    '(function () {',
    `  var moduleB64 = '${moduleB64}';`,
    "  var binary = atob(moduleB64);",
    '  var bytes = new Uint8Array(binary.length);',
    '  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);',
    "  var blob = new Blob([bytes], { type: 'text/javascript' });",
    '  var moduleUrl = URL.createObjectURL(blob);',
    '  pdfPasswordLibPromise = import(moduleUrl).catch(function (err) {',
    '    pdfPasswordLibPromise = null;',
    '    throw err;',
    '  });',
    '})()',
  ].join('\n        ');

  if (!html.includes(CANTOO_IMPORT)) {
    throw new Error('Could not find @cantoo/pdf-lib dynamic import');
  }

  return html.replace(
    `pdfPasswordLibPromise = ${CANTOO_IMPORT}`,
    replacement,
  );
}

async function bundlePostalMime() {
  const result = await esbuild.build({
    entryPoints: [join(root, 'node_modules/postal-mime/src/postal-mime.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    minify: true,
    target: ['es2020'],
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

function replacePostalMimeImport(html, bundledEsm) {
  if (!html.includes(POSTAL_MIME_IMPORT)) {
    throw new Error('Could not find postal-mime dynamic import');
  }
  const moduleB64 = toBase64(bundledEsm);
  const replacement = [
    '(function () {',
    `  var moduleB64 = '${moduleB64}';`,
    "  var binary = atob(moduleB64);",
    '  var bytes = new Uint8Array(binary.length);',
    '  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);',
    "  var blob = new Blob([bytes], { type: 'text/javascript' });",
    '  var moduleUrl = URL.createObjectURL(blob);',
    '  return import(moduleUrl);',
    '})()',
  ].join('\n          ');
  // postalMimeLibPromise = import('...').then(...).catch(...)
  return html.replace(POSTAL_MIME_IMPORT, replacement);
}

function addOfflineBanner(html) {
  const marker = '<title>Менеджер документов PDF</title>';
  const banner =
    '\n  <!-- Offline build: all editor libraries are inlined; no internet required. -->';
  if (!html.includes(marker)) {
    throw new Error('Could not find <title> marker');
  }
  return html.replace(marker, marker + banner);
}

// The "About" modal only claims "no network calls" for this (offline) build.
function setOfflineFlag(html) {
  const needle = 'const PDF_MANAGER_OFFLINE_BUILD = false;';
  const replacement = 'const PDF_MANAGER_OFFLINE_BUILD = true;';
  if (!html.includes(needle)) {
    throw new Error('Could not find PDF_MANAGER_OFFLINE_BUILD flag');
  }
  return html.replace(needle, replacement);
}

async function main() {
  console.log('Reading', inputPath);
  let html = readFileSync(inputPath, 'utf8');

  console.log('Downloading head scripts...');
  const inlinedBlocks = new Map();
  for (const spec of HEAD_SCRIPTS) {
    process.stdout.write(`  ${spec.url}\n`);
    const code = await fetchText(spec.url);
    inlinedBlocks.set(spec.url, wrapInlineScript(code, spec.comment));
  }

  console.log('Downloading pdf.js worker...');
  const workerCode = await fetchText(PDFJS_WORKER_URL);

  console.log('Bundling @cantoo/pdf-lib...');
  const cantooBundle = await bundleCantooPdfLib();

  console.log('Bundling postal-mime...');
  const postalMimeBundle = await bundlePostalMime();

  html = addOfflineBanner(html);
  html = setOfflineFlag(html);
  html = replaceHeadScripts(html, inlinedBlocks);
  html = replacePdfJsWorker(html, workerCode);
  html = replaceCantooImport(html, cantooBundle);
  html = replacePostalMimeImport(html, postalMimeBundle);

  writeFileSync(outputPath, html, 'utf8');
  const sizeMb = (Buffer.byteLength(html, 'utf8') / (1024 * 1024)).toFixed(2);
  console.log(`Wrote ${outputPath} (${sizeMb} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

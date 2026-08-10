#!/usr/bin/env node
/**
 * Builds PDF_manager_offline_ru.html from the already-built
 * PDF_manager_offline.html: strips the language-switcher button and locks
 * the interface to Russian. Not linked from README - this is an extra
 * release asset for users who only ever want the Russian UI, still kept
 * up to date automatically by the release pipeline.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const inputPath = join(root, 'PDF_manager_offline.html');
const outputPath = join(root, 'PDF_manager_offline_ru.html');

/**
 * Replaces `search` with `replace`, requiring exactly one match. Throws
 * with `label` on mismatch so a future edit to PDF_manager_online.html that
 * silently breaks this transform fails loudly in CI instead of shipping a
 * broken ru-only build.
 */
function replaceOnce(html, search, replace, label) {
  const count = html.split(search).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly 1 match, found ${count}`);
  }
  return html.replace(search, replace);
}

function removeLangToggleButton(html) {
  const button =
    '      <button id="langToggleBtn" type="button" onclick="pmToggleLocale()" title="English" aria-label="English">\n' +
    '        <span id="langToggleFlag" aria-hidden="true">EN</span>\n' +
    '      </button>\n';
  return replaceOnce(html, button, '', 'lang toggle button markup');
}

function removeLangToggleDesktopCss(html) {
  const block =
    '    /* Language toggle (EN/RU) — between theme and About. */\n' +
    '    #langToggleBtn {\n' +
    '      position: absolute;\n' +
    '      top: calc(\n' +
    '        var(--pm-menu-ctrl-h, 42px)\n' +
    '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
    '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
    '        + var(--logo-popup-gap)\n' +
    '      );\n' +
    '      right: 0;\n' +
    '      width: 42px;\n' +
    '      height: 42px;\n' +
    '      padding: 0;\n' +
    '      border: 1px solid rgba(255,255,255,0.28);\n' +
    '      box-sizing: border-box;\n' +
    '      border-radius: 8px;\n' +
    '      background: #3d5468;\n' +
    '      color: #fff;\n' +
    '      display: flex;\n' +
    '      align-items: center;\n' +
    '      justify-content: center;\n' +
    '      cursor: pointer;\n' +
    '      box-shadow: 0 4px 14px rgba(0,0,0,0.5);\n' +
    '      opacity: 0;\n' +
    '      transform: translateY(-6px);\n' +
    '      pointer-events: none;\n' +
    '      transition: opacity 0.15s, transform 0.15s, background 0.15s;\n' +
    '      font-size: 16px;\n' +
    '      font-weight: 700;\n' +
    '      letter-spacing: 0.04em;\n' +
    '      line-height: 1;\n' +
    '    }\n' +
    '    #langToggleFlag {\n' +
    '      display: block;\n' +
    '      line-height: 1;\n' +
    '    }\n' +
    '    #langToggleBtn:hover { background: #3498db; }\n' +
    '    #langToggleBtn.show {\n' +
    '      opacity: 1;\n' +
    '      transform: translateY(0);\n' +
    '      pointer-events: auto;\n' +
    '    }\n';
  return replaceOnce(html, block, '', 'lang toggle desktop CSS block');
}

function removeLangToggleCollapsedRule(html) {
  return replaceOnce(
    html,
    '    .top-menu.collapsed #themeToggleBtn,\n    .top-menu.collapsed #langToggleBtn,\n    .top-menu.collapsed #aboutBtn,',
    '    .top-menu.collapsed #themeToggleBtn,\n    .top-menu.collapsed #aboutBtn,',
    'collapsed-menu hide-list rule',
  );
}

/** Removes one "+ var(--logo-popup-gap) + var(--logo-popup-btn)" slot from a calc() chain. */
function dropOneSlot(html, search, label) {
  const withExtraSlot = search;
  const withoutExtraSlot = search.replace(
    '\n        + var(--logo-popup-gap) + var(--logo-popup-btn)',
    '',
  );
  if (withoutExtraSlot === withExtraSlot) {
    throw new Error(`${label}: slot term not found to drop`);
  }
  return replaceOnce(html, withExtraSlot, withoutExtraSlot, label);
}

function reflowDesktopPopupSlots(html) {
  html = dropOneSlot(
    html,
    '    #logoMenuArea.expanded {\n' +
      '      /* logo + hide + theme + lang + about */\n' +
      '      height: calc(\n' +
      '        var(--pm-menu-ctrl-h, 42px)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '      );\n' +
      '    }\n',
    '#logoMenuArea.expanded height (no restore-help)',
  );
  html = dropOneSlot(
    html,
    '    /*"About" button - under language toggle.*/\n' +
      '    #aboutBtn {\n' +
      '      position: absolute;\n' +
      '      top: calc(\n' +
      '        var(--pm-menu-ctrl-h, 42px)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap)\n' +
      '      );\n',
    '#aboutBtn default top',
  );
  html = dropOneSlot(
    html,
    '    /* Restore help («?»): sits above About only while the corner tip is hidden. */\n' +
      '    #restoreHelpBtn {\n' +
      '      position: absolute;\n' +
      '      top: calc(\n' +
      '        var(--pm-menu-ctrl-h, 42px)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap)\n' +
      '      );\n',
    '#restoreHelpBtn default top',
  );
  html = dropOneSlot(
    html,
    '    #logoMenuArea.help-restore-on #aboutBtn {\n' +
      '      top: calc(\n' +
      '        var(--pm-menu-ctrl-h, 42px)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap)\n' +
      '      );\n' +
      '    }\n',
    '#logoMenuArea.help-restore-on #aboutBtn top',
  );
  html = dropOneSlot(
    html,
    '    #logoMenuArea.help-restore-on.expanded {\n' +
      '      height: calc(\n' +
      '        var(--pm-menu-ctrl-h, 42px)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '        + var(--logo-popup-gap) + var(--logo-popup-btn)\n' +
      '      );\n' +
      '    }\n',
    '#logoMenuArea.help-restore-on.expanded height',
  );
  return html;
}

function reflowMobilePopupSlots(html, label) {
  html = replaceOnce(
    html,
    '      #logoMenuArea.expanded {\n' +
      '        /* logo + theme + lang + about */\n' +
      '        height: calc(42px + 6px + 42px + 6px + 42px + 6px + 42px);\n' +
      '      }\n' +
      '      #themeToggleBtn {\n' +
      '        display: flex;\n' +
      '        top: 48px; /* 42 logo + 6 gap */\n' +
      '        right: 0;\n' +
      '      }\n' +
      '      #langToggleBtn {\n' +
      '        display: flex;\n' +
      '        top: 96px; /* 48 + 42 + 6 */\n' +
      '        right: 0;\n' +
      '      }\n' +
      '      #aboutBtn {\n' +
      '        display: flex;\n' +
      '        top: 144px; /* 96 + 42 + 6 */\n' +
      '        right: 0;\n' +
      '      }\n',
    '      #logoMenuArea.expanded {\n' +
      '        /* logo + theme + about */\n' +
      '        height: calc(42px + 6px + 42px + 6px + 42px);\n' +
      '      }\n' +
      '      #themeToggleBtn {\n' +
      '        display: flex;\n' +
      '        top: 48px; /* 42 logo + 6 gap */\n' +
      '        right: 0;\n' +
      '      }\n' +
      '      #aboutBtn {\n' +
      '        display: flex;\n' +
      '        top: 96px; /* 48 + 42 + 6 */\n' +
      '        right: 0;\n' +
      '      }\n',
    `mobile portrait popup slots (${label})`,
  );
  return html;
}

function reflowMobileLandscapePopupSlots(html) {
  return replaceOnce(
    html,
    '      #logoMenuArea.expanded {\n' +
      '        height: calc(42px + 6px + 42px + 6px + 42px + 6px + 42px);\n' +
      '      }\n' +
      '      #themeToggleBtn {\n' +
      '        display: flex;\n' +
      '        top: 48px; /* 42 logo + 6 gap */\n' +
      '        right: 0;\n' +
      '      }\n' +
      '      #langToggleBtn {\n' +
      '        display: flex;\n' +
      '        top: 96px;\n' +
      '        right: 0;\n' +
      '      }\n' +
      '      #aboutBtn {\n' +
      '        display: flex;\n' +
      '        top: 144px;\n' +
      '        right: 0;\n' +
      '      }\n',
    '      #logoMenuArea.expanded {\n' +
      '        height: calc(42px + 6px + 42px + 6px + 42px);\n' +
      '      }\n' +
      '      #themeToggleBtn {\n' +
      '        display: flex;\n' +
      '        top: 48px; /* 42 logo + 6 gap */\n' +
      '        right: 0;\n' +
      '      }\n' +
      '      #aboutBtn {\n' +
      '        display: flex;\n' +
      '        top: 96px;\n' +
      '        right: 0;\n' +
      '      }\n',
    'mobile landscape popup slots',
  );
}

function forcePreBootLocaleRu(html) {
  const search =
    "      try {\n" +
    "        var loc = localStorage.getItem('pmLocale');\n" +
    "        if (loc !== 'en' && loc !== 'ru' && loc !== 'es') {\n" +
    "          var nav = String((navigator.languages && navigator.languages[0]) || navigator.language || '').toLowerCase();\n" +
    "          loc = nav.indexOf('en') === 0 ? 'en' : (nav.indexOf('es') === 0 ? 'es' : 'ru');\n" +
    "        }\n" +
    "        document.documentElement.setAttribute('lang', loc === 'en' ? 'en' : (loc === 'es' ? 'es' : 'ru'));\n" +
    "        if (loc === 'en') document.title = 'PDF Document Manager';\n" +
    "        else if (loc === 'es') document.title = 'Gestor de Documentos PDF';\n" +
    "      } catch (e2) { /* ignore */ }\n";
  const replace =
    "      try {\n" +
    "        document.documentElement.setAttribute('lang', 'ru');\n" +
    "      } catch (e2) { /* ignore */ }\n";
  return replaceOnce(html, search, replace, 'pre-boot locale detection');
}

function forceRuntimeLocaleRu(html) {
  const search =
    "    function pmDetectLocale() {\n" +
    "      try {\n" +
    "        const saved = localStorage.getItem(PM_LOCALE_KEY);\n" +
    "        if (saved === 'en' || saved === 'ru' || saved === 'es') return saved;\n" +
    "      } catch (_) {}\n" +
    "      try {\n" +
    "        const langs = (navigator.languages && navigator.languages.length)\n" +
    "          ? navigator.languages : [navigator.language || navigator.userLanguage || ''];\n" +
    "        for (let i = 0; i < langs.length; i++) {\n" +
    "          const l = String(langs[i] || '').toLowerCase();\n" +
    "          if (l.startsWith('en')) return 'en';\n" +
    "          if (l.startsWith('es')) return 'es';\n" +
    "          if (l.startsWith('ru')) return 'ru';\n" +
    "        }\n" +
    "      } catch (_) {}\n" +
    "      return 'ru';\n" +
    "    }\n";
  const replace =
    "    function pmDetectLocale() {\n" +
    "      return 'ru';\n" +
    "    }\n";
  return replaceOnce(html, search, replace, 'pmDetectLocale');
}

async function main() {
  console.log('Reading', inputPath);
  let html = readFileSync(inputPath, 'utf8');

  html = removeLangToggleButton(html);
  html = removeLangToggleDesktopCss(html);
  html = removeLangToggleCollapsedRule(html);
  html = reflowDesktopPopupSlots(html);
  html = reflowMobilePopupSlots(html, 'portrait');
  html = reflowMobileLandscapePopupSlots(html);
  html = forcePreBootLocaleRu(html);
  html = forceRuntimeLocaleRu(html);

  writeFileSync(outputPath, html, 'utf8');
  const sizeMb = (Buffer.byteLength(html, 'utf8') / (1024 * 1024)).toFixed(2);
  console.log(`Wrote ${outputPath} (${sizeMb} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * The Tauri shell only runs commands its capability allows: every command
 * registered in src-tauri/src/lib.rs (generate_handler!) must be listed in
 * src-tauri/permissions/open-pdf.toml, and every command the UI invokes
 * must be a registered one. A command left out builds fine and then fails
 * at run time with "Command … not allowed by ACL".
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const lib = read('src-tauri/src/lib.rs');
const block = /generate_handler!\[([\s\S]*?)\n\s*\]\)/.exec(lib);
if (!block) {
  console.error('generate_handler! not found in src-tauri/src/lib.rs');
  process.exit(1);
}
const registered = new Set(
  [...block[1].matchAll(/^\s*([\w:]+),?\s*$/gm)].map((m) => m[1].split('::').pop()),
);

const toml = read('src-tauri/permissions/open-pdf.toml');
const allowed = new Set([...toml.split('commands.allow')[1].matchAll(/"(\w+)"/g)].map((m) => m[1]));

const ui = read('scripts/prepare-tauri-ui.mjs') + read('PDF_manager_online.html');
const invoked = new Set(
  [...ui.matchAll(/invoke(?:\.call\([^,]+,\s*|\()\s*'(\w+)'/g)].map((m) => m[1]),
);

const notAllowed = [...registered].filter((c) => !allowed.has(c));
const unknown = [...invoked].filter((c) => !registered.has(c));
if (notAllowed.length) console.error('Not allowed in open-pdf.toml:', notAllowed.join(', '));
if (unknown.length) console.error('Invoked by the UI but not registered:', unknown.join(', '));
if (notAllowed.length || unknown.length) process.exit(1);
console.log(`ACL OK: ${registered.size} commands registered and allowed, ${invoked.size} invoked by the UI.`);

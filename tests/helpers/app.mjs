import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BLANK_PDF = readFileSync(join(__dirname, '../fixtures/blank-a4.pdf'));

/** Open the app and wait until PDF libs + app globals are ready. */
export async function openApp(page) {
  await page.goto('/PDF_manager_online.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    return typeof window.loadPDF === 'function'
      && typeof window.openPageEditor === 'function'
      && typeof window.PDFLib !== 'undefined'
      && typeof window.pdfjsLib !== 'undefined'
      && Object.prototype.hasOwnProperty.call(window, '__peState');
  }, null, { timeout: 45_000 });
}

/** Inject a PDF via the app's loadPDF(File) API (no file-picker UI). */
export async function loadBlankPdf(page, bytes = BLANK_PDF) {
  await page.evaluate(async (arr) => {
    const file = new File([new Uint8Array(arr)], 'blank-a4.pdf', { type: 'application/pdf' });
    await window.loadPDF(file);
  }, [...bytes]);
  await page.waitForSelector('.page[data-index="0"]', { timeout: 45_000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('loadingOverlay');
    return !el || el.style.display !== 'flex';
  }, null, { timeout: 45_000 });
  await page.waitForFunction(() => {
    return typeof window.pageEditAvailable === 'function' && window.pageEditAvailable();
  }, null, { timeout: 45_000 });
}

export async function openPageEditor(page, idx = 0) {
  await page.evaluate((i) => window.openPageEditor(i), idx);
  await expect(page.locator('#pageEditModal')).toHaveClass(/open/, { timeout: 45_000 });
  await page.waitForFunction(() => {
    const s = window.__peState;
    return !!(s && s.viewport
      && document.getElementById('peStage')
      && document.getElementById('peObjLayer'));
  }, null, { timeout: 45_000 });
  // Stage must have a real size before click→object math works.
  await page.waitForFunction(() => {
    const st = document.getElementById('peStage');
    if (!st) return false;
    const r = st.getBoundingClientRect();
    return r.width > 40 && r.height > 40;
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('loadingOverlay');
    return !el || el.style.display !== 'flex';
  });
}

export async function closePageEditorCancel(page, { discard = true } = {}) {
  page.once('dialog', async (dialog) => {
    if (discard) await dialog.accept();
    else await dialog.dismiss();
  });
  await page.locator('#peCancelBtn').click();
  if (discard) {
    await expect(page.locator('#pageEditModal')).not.toHaveClass(/open/);
  } else {
    await expect(page.locator('#pageEditModal')).toHaveClass(/open/);
  }
}

export async function peSnapshot(page) {
  return page.evaluate(() => {
    const s = window.__peState;
    if (!s) return null;
    return {
      tool: s.tool,
      objSelectMode: !!s.objSelectMode,
      inlineEditId: s.inlineEditId,
      selId: s.sel && s.sel.id,
      selType: s.sel && s.sel.type,
      selShape: s.sel && s.sel.shape,
      multiSelIds: (s.multiSel || []).map((o) => o.id),
      objectCount: s.objects.length,
      objects: s.objects.map((o) => ({
        id: o.id,
        type: o.type,
        shape: o.shape || null,
        text: o.text || '',
        x: o.x, y: o.y, w: o.w, h: o.h,
        filled: !!o.filled,
        pathLen: Array.isArray(o.path) ? o.path.length : 0,
      })),
    };
  });
}

export async function stageCenter(page) {
  return page.locator('#peStage').boundingBox();
}

/** Click the stage at a fraction of its size (0..1). */
export async function clickStage(page, fx = 0.5, fy = 0.4, opts = {}) {
  const box = await page.locator('#peStage').boundingBox();
  if (!box) throw new Error('#peStage has no box');
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy, opts);
}

/** Drag on the stage from one fraction to another. */
export async function dragStage(page, x1, y1, x2, y2, { steps = 10 } = {}) {
  const box = await page.locator('#peStage').boundingBox();
  if (!box) throw new Error('#peStage has no box');
  const a = { x: box.x + box.width * x1, y: box.y + box.height * y1 };
  const b = { x: box.x + box.width * x2, y: box.y + box.height * y2 };
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
  return { a, b, box };
}

export async function enableObjSelect(page) {
  await page.evaluate(() => {
    window.peSetTool('select');
    window.peSetObjSelectMode(true);
  });
  await page.waitForFunction(() => {
    const s = window.__peState;
    return s && s.tool === 'select' && s.objSelectMode;
  });
}

export async function drawShape(page, kind, x1, y1, x2, y2) {
  await page.evaluate((k) => {
    window.peSelectShapeKind(k);
    window.peSetTool('shape');
  }, kind);
  await page.waitForFunction((k) => {
    const s = window.__peState;
    return s && s.tool === 'shape';
  }, kind);
  await dragStage(page, x1, y1, x2, y2);
  await page.waitForFunction(() => {
    const s = window.__peState;
    return s && !s.drag && !s.draftShapeId;
  }, null, { timeout: 5000 });
}

/** Seed filled rect shapes (normalized coords). Returns ids in order. */
export async function seedShapes(page, rects) {
  return page.evaluate((list) => {
    const s = window.__peState;
    const ids = [];
    for (const r of list) {
      const o = {
        id: ++s.seq,
        type: 'shape',
        shape: r.shape || 'rect',
        color: r.color || '#000000',
        rot: 0,
        filled: r.filled !== false,
        opacity: r.opacity != null ? r.opacity : 80,
        strokePx: 2,
        x: r.x, y: r.y, w: r.w, h: r.h,
      };
      s.objects.push(o);
      ids.push(o.id);
    }
    window.peRedrawObjects();
    return ids;
  }, rects);
}

export async function clickObjectById(page, id, opts = {}) {
  const box = await page.locator(`#peObjLayer .pe-obj[data-pe-id="${id}"]`).boundingBox();
  if (!box) throw new Error('object box missing: ' + id);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, opts);
}

export async function createTextAt(page, fx = 0.5, fy = 0.35, text = 'Тест') {
  await page.locator('#peToolText').click();
  await page.waitForFunction(() => window.__peState && window.__peState.tool === 'text');
  await clickStage(page, fx, fy);
  await expect(page.locator('#peObjLayer .pe-obj-text.pe-inline-edit')).toBeVisible();
  const editor = page.locator('#peObjLayer .pe-obj-text.pe-inline-edit');
  await editor.click();
  await page.keyboard.type(text, { delay: 15 });
  return editor;
}

/** Seed a text block under a filled rect (shape later in list = on top in DOM). */
export async function seedTextUnderShape(page) {
  return page.evaluate(() => {
    const s = window.__peState;
    const text = {
      id: ++s.seq,
      type: 'text',
      text: 'Каретка',
      html: 'Каретка',
      fontPt: 22,
      color: '#d90000',
      x: 0.28,
      y: 0.32,
    };
    const shape = {
      id: ++s.seq,
      type: 'shape',
      shape: 'rect',
      color: '#3498db',
      rot: 0,
      filled: true,
      opacity: 55,
      strokePx: 2,
      x: 0.22,
      y: 0.28,
      w: 0.35,
      h: 0.12,
    };
    s.objects.push(text, shape);
    window.peRedrawObjects();
    return { textId: text.id, shapeId: shape.id };
  });
}

export async function beginEditTextById(page, textId) {
  await page.evaluate((id) => {
    const s = window.__peState;
    const o = s.objects.find((x) => x.id === id);
    if (!o) throw new Error('text not found: ' + id);
    window.peSetTool('select');
    window.peSetObjSelectMode(true);
    window.peSelect(o);
    window.peBeginInlineEdit(o);
    window.peFocusInlineEditorNow();
  }, textId);
  await expect(page.locator('#peObjLayer .pe-obj-text.pe-inline-edit')).toBeVisible();
}

/** Contrast helper: relative luminance + WCAG contrast ratio. */
export function contrastRatio(fg, bg) {
  const lum = (hex) => {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const L1 = lum(fg);
  const L2 = lum(bg);
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

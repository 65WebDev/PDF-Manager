import { test, expect } from '@playwright/test';
import {
  openApp,
  loadBlankPdf,
  openPageEditor,
  peSnapshot,
  clickStage,
  dragStage,
  enableObjSelect,
  drawShape,
  seedShapes,
  clickObjectById,
} from './helpers/app.mjs';

async function bootEditor(page) {
  await openApp(page);
  await loadBlankPdf(page);
  await openPageEditor(page, 0);
}

test.describe('Object select', () => {
  test.beforeEach(async ({ page }) => {
    await bootEditor(page);
  });

  test('editor opens in object-select mode by default', async ({ page }) => {
    const snap = await peSnapshot(page);
    expect(snap.tool).toBe('select');
    expect(snap.objSelectMode).toBe(true);
    await expect(page.locator('#peToolObjSelect')).toHaveClass(/active/);
    await expect(page.locator('#pageEditModal')).toHaveClass(/pe-obj-select-mode/);
  });

  test('object-select button stays sticky when clicked again', async ({ page }) => {
    await page.locator('#peToolHand').click();
    await page.waitForFunction(() => window.__peState && !window.__peState.objSelectMode);
    await page.locator('#peToolObjSelect').click();
    await page.waitForFunction(() => window.__peState && window.__peState.objSelectMode);
    await page.locator('#peToolObjSelect').click();
    const snap = await peSnapshot(page);
    expect(snap.objSelectMode).toBe(true);
    expect(snap.tool).toBe('select');
  });

  test('blank click deselects but keeps object-select mode', async ({ page }) => {
    const [id] = await seedShapes(page, [
      { x: 0.2, y: 0.2, w: 0.2, h: 0.12 },
    ]);
    await enableObjSelect(page);
    await clickObjectById(page, id);
    expect((await peSnapshot(page)).selId).toBe(id);

    await clickStage(page, 0.85, 0.85);
    await page.waitForFunction(() => window.__peState && !window.__peState.sel);
    const snap = await peSnapshot(page);
    expect(snap.selId).toBeNull();
    expect(snap.objSelectMode).toBe(true);
    expect(snap.objectCount).toBe(1);
  });

  test('Shift+click multi-selects two shapes and Delete removes both', async ({ page }) => {
    const [a, b] = await seedShapes(page, [
      { x: 0.15, y: 0.2, w: 0.18, h: 0.1, color: '#c0392b' },
      { x: 0.55, y: 0.2, w: 0.18, h: 0.1, color: '#2980b9' },
    ]);
    await enableObjSelect(page);
    await clickObjectById(page, a);
    expect((await peSnapshot(page)).selId).toBe(a);

    // Hold Shift via keyboard so pointer events see shiftKey reliably.
    await page.keyboard.down('Shift');
    await clickObjectById(page, b);
    await page.keyboard.up('Shift');

    await page.waitForFunction((ids) => {
      const s = window.__peState;
      if (!s || !s.sel) return false;
      const selected = [s.sel.id, ...(s.multiSel || []).map((o) => o.id)];
      return selected.includes(ids.a) && selected.includes(ids.b);
    }, { a, b });

    let snap = await peSnapshot(page);
    const selected = new Set([snap.selId, ...snap.multiSelIds].filter(Boolean));
    expect(selected.has(a)).toBe(true);
    expect(selected.has(b)).toBe(true);
    expect(selected.size).toBe(2);
    await expect(page.locator('#peObjLayer .pe-obj.sel')).toHaveCount(2);
    await expect(page.locator('#peDeleteObj')).toBeEnabled();

    await page.locator('#peDeleteObj').click();
    await page.waitForFunction(() => window.__peState && window.__peState.objects.length === 0);
    snap = await peSnapshot(page);
    expect(snap.objectCount).toBe(0);
    expect(snap.selId).toBeNull();
    await expect(page.locator('#peDeleteObj')).toBeDisabled();
  });

  test('marquee drag selects multiple shapes', async ({ page }) => {
    const [a, b] = await seedShapes(page, [
      { x: 0.25, y: 0.25, w: 0.15, h: 0.1 },
      { x: 0.45, y: 0.28, w: 0.15, h: 0.1 },
    ]);
    await enableObjSelect(page);

    const box = await page.locator('#peStage').boundingBox();
    const x1 = box.x + box.width * 0.18;
    const y1 = box.y + box.height * 0.18;
    const x2 = box.x + box.width * 0.7;
    const y2 = box.y + box.height * 0.5;

    // Double-tap blank: first click registers tap; second pointerdown starts marquee.
    await page.mouse.click(x1, y1);
    await page.waitForTimeout(60);
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 14 });
    await page.mouse.up();

    await page.waitForFunction((ids) => {
      const s = window.__peState;
      if (!s || !s.sel) return false;
      const selected = [s.sel.id, ...(s.multiSel || []).map((o) => o.id)];
      return selected.includes(ids.a) && selected.includes(ids.b);
    }, { a, b }, { timeout: 5000 });

    const snap = await peSnapshot(page);
    const selected = new Set([snap.selId, ...snap.multiSelIds]);
    expect(selected.has(a)).toBe(true);
    expect(selected.has(b)).toBe(true);
  });

  test('overlap click without drag cycles selection', async ({ page }) => {
    // Bottom then top — later object is on top in DOM.
    const [bottom, top] = await seedShapes(page, [
      { x: 0.3, y: 0.3, w: 0.25, h: 0.16, color: '#e74c3c' },
      { x: 0.34, y: 0.34, w: 0.25, h: 0.16, color: '#3498db', opacity: 70 },
    ]);
    await enableObjSelect(page);

    // First click hits the top shape.
    await clickObjectById(page, top);
    expect((await peSnapshot(page)).selId).toBe(top);

    // Click without drag on the overlap → cycle toward the other object.
    await clickObjectById(page, top);
    await page.waitForFunction((ids) => {
      const s = window.__peState;
      return s && s.sel && (s.sel.id === ids.bottom || s.sel.id === ids.top);
    }, { bottom, top });

    const afterFirstCycle = (await peSnapshot(page)).selId;
    // One of the two; if still top, one more click should reach bottom.
    if (afterFirstCycle === top) {
      await clickObjectById(page, top);
    }
    const snap = await peSnapshot(page);
    expect([bottom, top]).toContain(snap.selId);
    // After at most two cycles from top, we must have visited bottom at least once.
    // Force one more cycle and assert the selection changed at some point.
    const before = snap.selId;
    await clickObjectById(page, before);
    const after = (await peSnapshot(page)).selId;
    expect(after).not.toBe(before);
    expect([bottom, top]).toContain(after);
  });

  test('overlap drag moves the selected shape without cycling', async ({ page }) => {
    const [bottom, top] = await seedShapes(page, [
      { x: 0.3, y: 0.3, w: 0.22, h: 0.14, color: '#e74c3c' },
      { x: 0.34, y: 0.34, w: 0.22, h: 0.14, color: '#3498db', opacity: 70 },
    ]);
    await enableObjSelect(page);
    await clickObjectById(page, top);
    const before = (await peSnapshot(page)).objects.find((o) => o.id === top);

    const box = await page.locator(`#peObjLayer .pe-obj[data-pe-id="${top}"]`).boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy + 30, { steps: 10 });
    await page.mouse.up();

    await page.waitForFunction((id) => {
      const s = window.__peState;
      const o = s && s.objects.find((x) => x.id === id);
      return o && (Math.abs(o.x - 0.34) > 0.01 || Math.abs(o.y - 0.34) > 0.01);
    }, top);

    const snap = await peSnapshot(page);
    expect(snap.selId).toBe(top);
    const after = snap.objects.find((o) => o.id === top);
    expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeGreaterThan(0.01);
    // Bottom should still exist (not deleted / not swapped away).
    expect(snap.objects.some((o) => o.id === bottom)).toBe(true);
  });
});

test.describe('Shape drawing', () => {
  test.beforeEach(async ({ page }) => {
    await bootEditor(page);
  });

  test('draws rect, ellipse, and line with keepTool', async ({ page }) => {
    await drawShape(page, 'rect', 0.15, 0.15, 0.35, 0.28);
    let snap = await peSnapshot(page);
    expect(snap.tool).toBe('shape');
    expect(snap.objects.some((o) => o.shape === 'rect' && o.w > 0.05)).toBe(true);
    expect(snap.selShape).toBe('rect');
    await expect(page.locator('#peObjLayer .pe-obj-shape.sel .pe-text-corner-handle')).toHaveCount(4);

    // Blank click deselects but keeps shape tool.
    await page.waitForTimeout(100);
    await clickStage(page, 0.9, 0.9);
    await page.waitForFunction(() => window.__peState && !window.__peState.sel);
    expect((await peSnapshot(page)).tool).toBe('shape');

    await drawShape(page, 'ellipse', 0.5, 0.15, 0.7, 0.3);
    snap = await peSnapshot(page);
    expect(snap.objects.some((o) => o.shape === 'ellipse')).toBe(true);

    await clickStage(page, 0.9, 0.85);
    await page.waitForFunction(() => window.__peState && !window.__peState.sel);
    await drawShape(page, 'line', 0.2, 0.55, 0.55, 0.7);
    snap = await peSnapshot(page);
    const line = snap.objects.find((o) => o.shape === 'line');
    expect(line).toBeTruthy();
    expect(line.w).toBeGreaterThan(0.05);
    await expect(page.locator('#peObjLayer .pe-obj-shape.sel .pe-vector-start')).toBeVisible();
    await expect(page.locator('#peObjLayer .pe-obj-shape.sel .pe-vector-end')).toBeVisible();
  });

  test('tiny rect drag is discarded; tool stays shape', async ({ page }) => {
    await page.evaluate(() => {
      window.peSelectShapeKind('rect');
      window.peSetTool('shape');
    });
    // Sub-threshold box (normalized w/h < 0.005).
    await dragStage(page, 0.4, 0.4, 0.402, 0.402, { steps: 2 });
    await page.waitForFunction(() => {
      const s = window.__peState;
      return s && !s.drag && !s.draftShapeId;
    });
    const snap = await peSnapshot(page);
    expect(snap.objects.filter((o) => o.type === 'shape')).toHaveLength(0);
    expect(snap.tool).toBe('shape');
    expect(snap.selId).toBeNull();
  });

  test('freehand keeps a real stroke and discards a tiny scribble', async ({ page }) => {
    await page.evaluate(() => {
      window.peSelectShapeKind('freehand');
      window.peSetTool('shape');
    });
    // Tiny scribble → discard (< 6px path).
    await dragStage(page, 0.2, 0.2, 0.201, 0.201, { steps: 2 });
    await page.waitForFunction(() => {
      const s = window.__peState;
      return s && !s.drag && !s.draftShapeId;
    });
    expect((await peSnapshot(page)).objects.filter((o) => o.shape === 'freehand')).toHaveLength(0);

    // Longer stroke → keep.
    await dragStage(page, 0.25, 0.4, 0.55, 0.55, { steps: 20 });
    await page.waitForFunction(() => {
      const s = window.__peState;
      return s && s.objects.some((o) => o.shape === 'freehand');
    });
    const snap = await peSnapshot(page);
    const fh = snap.objects.find((o) => o.shape === 'freehand');
    expect(fh).toBeTruthy();
    expect(fh.pathLen).toBeGreaterThanOrEqual(2);
    expect(snap.tool).toBe('shape');
  });

  test('Ctrl+Z after draw removes shape but keeps shape tool', async ({ page }) => {
    await drawShape(page, 'rect', 0.2, 0.2, 0.45, 0.35);
    expect((await peSnapshot(page)).objects.some((o) => o.shape === 'rect')).toBe(true);

    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => {
      const s = window.__peState;
      return s && s.objects.filter((o) => o.type === 'shape').length === 0;
    });
    const snap = await peSnapshot(page);
    expect(snap.tool).toBe('shape');
    expect(snap.objectCount).toBe(0);

    // Can draw again without re-opening the shape menu.
    await dragStage(page, 0.3, 0.3, 0.5, 0.45);
    await page.waitForFunction(() => {
      const s = window.__peState;
      return s && s.objects.some((o) => o.shape === 'rect' && o.w > 0.05);
    });
    expect((await peSnapshot(page)).tool).toBe('shape');
  });

  test('Esc with a selected shape leaves the shape tool for select', async ({ page }) => {
    await drawShape(page, 'rect', 0.25, 0.25, 0.45, 0.4);
    expect((await peSnapshot(page)).selId).not.toBeNull();

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const s = window.__peState;
      return s && s.tool === 'select' && !s.sel;
    });
    const snap = await peSnapshot(page);
    expect(snap.tool).toBe('select');
    // modeBeforeTool should restore object-select.
    expect(snap.objSelectMode).toBe(true);
    expect(snap.objectCount).toBe(1);
  });

  test('arrow draw yields vector handles', async ({ page }) => {
    await drawShape(page, 'arrow', 0.2, 0.5, 0.6, 0.65);
    const snap = await peSnapshot(page);
    expect(snap.objects.some((o) => o.shape === 'arrow')).toBe(true);
    await expect(page.locator('#peObjLayer .pe-obj-shape.sel .pe-vector-start')).toBeVisible();
    await expect(page.locator('#peObjLayer .pe-obj-shape.sel .pe-vector-end')).toBeVisible();
    await expect(page.locator('#peObjLayer .pe-obj-shape.sel .pe-vector-bend')).toBeVisible();
  });
});

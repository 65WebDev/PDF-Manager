import { test, expect } from '@playwright/test';
import {
  openApp,
  loadBlankPdf,
  openPageEditor,
  closePageEditorCancel,
  peSnapshot,
  createTextAt,
  clickStage,
  seedTextUnderShape,
  beginEditTextById,
  contrastRatio,
} from './helpers/app.mjs';

test.describe('Page editor smoke', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await loadBlankPdf(page);
    await openPageEditor(page, 0);
  });

  test('opens editor with stage and default select tool', async ({ page }) => {
    await expect(page.locator('#pageEditModal')).toHaveClass(/open/);
    await expect(page.locator('#peStage')).toBeVisible();
    await expect(page.locator('#peObjLayer')).toBeVisible();
    const snap = await peSnapshot(page);
    expect(snap.tool).toBe('select');
    expect(snap.objectCount).toBe(0);
  });

  test('creates and types into a text block', async ({ page }) => {
    await createTextAt(page, 0.45, 0.3, 'Привет PDF');
    const snap = await peSnapshot(page);
    expect(snap.inlineEditId).not.toBeNull();
    expect(snap.objectCount).toBe(1);
    expect(snap.objects[0].type).toBe('text');
    await expect(page.locator('#peObjLayer .pe-obj-text.pe-inline-edit'))
      .toContainText('Привет PDF');
  });

  test('Esc ends text edit but keeps the text object', async ({ page }) => {
    await createTextAt(page, 0.4, 0.28, 'EscTest');
    await page.keyboard.press('Escape');
    // First Esc may only end inline edit (not close modal).
    await page.waitForFunction(() => window.__peState && !window.__peState.inlineEditId);
    const snap = await peSnapshot(page);
    expect(snap.inlineEditId).toBeNull();
    expect(snap.objectCount).toBe(1);
    await expect(page.locator('#pageEditModal')).toHaveClass(/open/);
  });

  test('switching to shape tool ends text editing', async ({ page }) => {
    await createTextAt(page, 0.4, 0.3, 'KeepTool');
    await page.evaluate(() => {
      window.peSelectShapeKind('rect');
      window.peSetTool('shape');
    });
    await page.waitForFunction(() => {
      const s = window.__peState;
      return s && s.tool === 'shape' && !s.inlineEditId;
    });
    const snap = await peSnapshot(page);
    expect(snap.inlineEditId).toBeNull();
    expect(snap.tool).toBe('shape');
    expect(snap.objectCount).toBeGreaterThanOrEqual(1);
  });

  test('cancel closes the editor without leaving modal open', async ({ page }) => {
    await createTextAt(page, 0.5, 0.35, 'Draft');
    await closePageEditorCancel(page, { discard: true });
    await expect(page.locator('#pageEditModal')).not.toHaveClass(/open/);
    const peGone = await page.evaluate(() => window.__peState == null);
    expect(peGone).toBe(true);
  });

  test('cancel confirm dismiss keeps the editor open', async ({ page }) => {
    await createTextAt(page, 0.5, 0.35, 'Keep');
    await closePageEditorCancel(page, { discard: false });
    const snap = await peSnapshot(page);
    expect(snap).not.toBeNull();
    expect(snap.objectCount).toBe(1);
  });
});

test.describe('Caret vs overlapping objects', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await loadBlankPdf(page);
    await openPageEditor(page, 0);
  });

  test('LMB for caret does not select covering shape over editing text', async ({ page }) => {
    const ids = await seedTextUnderShape(page);
    await beginEditTextById(page, ids.textId);

    const before = await peSnapshot(page);
    expect(before.inlineEditId).toBe(ids.textId);

    // Click the geometric center of the text outer box (also covered by the shape).
    const box = await page.locator(
      `#peObjLayer .pe-obj[data-pe-id="${ids.textId}"]`
    ).boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    const after = await peSnapshot(page);
    expect(after.inlineEditId, 'should stay in text edit after caret click').toBe(ids.textId);
    expect(after.selId, 'should not select the covering shape').not.toBe(ids.shapeId);
    await expect(page.locator('#peObjLayer .pe-obj-text.pe-inline-edit')).toBeVisible();

    // Editing text must sit above the cover for hit-testing.
    const z = await page.evaluate((textId) => {
      const textEl = document.querySelector(`#peObjLayer .pe-obj[data-pe-id="${textId}"]`);
      const shapeEl = document.querySelector(`#peObjLayer .pe-obj-shape`);
      return {
        textZ: textEl ? getComputedStyle(textEl).zIndex : null,
        shapeZ: shapeEl ? getComputedStyle(shapeEl).zIndex : null,
      };
    }, ids.textId);
    expect(Number(z.textZ)).toBeGreaterThan(Number(z.shapeZ) || 0);
  });

  test('clicking clearly outside text on the cover selects the shape', async ({ page }) => {
    const ids = await seedTextUnderShape(page);
    await beginEditTextById(page, ids.textId);

    const shapeBox = await page.locator(
      `#peObjLayer .pe-obj[data-pe-id="${ids.shapeId}"]`
    ).boundingBox();
    const textBox = await page.locator(
      `#peObjLayer .pe-obj[data-pe-id="${ids.textId}"]`
    ).boundingBox();
    expect(shapeBox && textBox).toBeTruthy();

    // Click near the top-left of the shape, outside the text box if possible.
    let x = shapeBox.x + 8;
    let y = shapeBox.y + 8;
    if (
      x >= textBox.x && x <= textBox.x + textBox.width
      && y >= textBox.y && y <= textBox.y + textBox.height
    ) {
      x = shapeBox.x + shapeBox.width - 8;
      y = shapeBox.y + 8;
    }

    await page.mouse.click(x, y);
    await page.waitForFunction(
      (shapeId) => window.__peState && !window.__peState.inlineEditId
        && window.__peState.sel && window.__peState.sel.id === shapeId,
      ids.shapeId,
      { timeout: 5000 }
    ).catch(() => {});

    const after = await peSnapshot(page);
    // Suspicious if still editing after a clear outside click — flag for review.
    expect(after.inlineEditId, 'outside click should leave text edit').toBeNull();
    expect(after.selId).toBe(ids.shapeId);
  });
});

test.describe('About dialog dark theme', () => {
  test('update-fail banner stays readable on dark background', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      window.pmApplyTheme('dark');
      window.pdfManagerCheckForUpdates = async () => null;
      window.showAboutModal();
    });
    const line = page.locator('#aboutUpdateLine');
    await expect(line).toBeVisible({ timeout: 10_000 });
    await expect(line).toContainText(/Не удалось проверить обновления/);

    const styles = await line.evaluate((el) => {
      const cs = getComputedStyle(el);
      const parse = (c) => {
        const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return c;
        const hex = (n) => Number(n).toString(16).padStart(2, '0');
        return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
      };
      return {
        color: parse(cs.color),
        background: parse(cs.backgroundColor),
        className: el.className,
      };
    });

    expect(styles.className).toContain('pm-about-update-fail');
    const ratio = contrastRatio(styles.color, styles.background);
    // Soft floor: flag for human review if barely readable / near-white bg.
    const bgLum = (() => {
      const h = styles.background.replace('#', '');
      const n = parseInt(h, 16);
      const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    })();
    expect(bgLum, 'banner background should not be light in dark theme').toBeLessThan(0.45);
    expect(ratio, `contrast ${ratio.toFixed(2)} (${styles.color} on ${styles.background})`)
      .toBeGreaterThanOrEqual(3);
  });
});

test.describe('Object-select basics', () => {
  test('object-select mode can select a text object', async ({ page }) => {
    await openApp(page);
    await loadBlankPdf(page);
    await openPageEditor(page, 0);
    await createTextAt(page, 0.5, 0.4, 'SelectMe');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__peState && !window.__peState.inlineEditId);

    await page.locator('#peToolObjSelect').click();
    await page.waitForFunction(() => window.__peState && window.__peState.objSelectMode);

    const textBox = await page.locator('#peObjLayer .pe-obj-text').boundingBox();
    expect(textBox).toBeTruthy();
    await page.mouse.click(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2);

    const snap = await peSnapshot(page);
    expect(snap.selType).toBe('text');
    expect(snap.objectCount).toBe(1);
  });

  test('drawing a rect shape yields a shape object', async ({ page }) => {
    await openApp(page);
    await loadBlankPdf(page);
    await openPageEditor(page, 0);

    await page.evaluate(() => {
      window.peSelectShapeKind('rect');
      window.peSetTool('shape');
    });
    await page.waitForFunction(() => window.__peState && window.__peState.tool === 'shape');

    const box = await page.locator('#peStage').boundingBox();
    const x1 = box.x + box.width * 0.3;
    const y1 = box.y + box.height * 0.3;
    const x2 = box.x + box.width * 0.55;
    const y2 = box.y + box.height * 0.45;
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 8 });
    await page.mouse.up();

    await page.waitForFunction(() => {
      const s = window.__peState;
      return s && s.objects.some((o) => o.type === 'shape' && o.w > 0.01);
    });
    const snap = await peSnapshot(page);
    const shapes = snap.objects.filter((o) => o.type === 'shape');
    expect(shapes.length).toBeGreaterThanOrEqual(1);
    expect(shapes[0].w).toBeGreaterThan(0.05);
    expect(shapes[0].h).toBeGreaterThan(0.05);
  });
});

// Behaviour probes — failures here may be product bugs OR wrong expectations.
test.describe('Behaviour probes (confirm with product owner)', () => {
  test('in object-select mode, blank stage click ends text edit', async ({ page }) => {
    await openApp(page);
    await loadBlankPdf(page);
    await openPageEditor(page, 0);
    await createTextAt(page, 0.35, 0.3, 'Probe');
    const textId = (await peSnapshot(page)).objects[0].id;
    // Commit the Text-tool draft, then re-enter edit under Object-select.
    await page.evaluate(() => {
      window.peSetTool('select');
      window.peSetObjSelectMode(true);
    });
    await page.waitForFunction(() => window.__peState && !window.__peState.inlineEditId);
    await beginEditTextById(page, textId);
    await page.waitForTimeout(500); // past peInlineEditStartedAt 450ms guard
    await clickStage(page, 0.85, 0.85);
    await page.waitForFunction(() => window.__peState && !window.__peState.inlineEditId, null, {
      timeout: 5000,
    });
    const snap = await peSnapshot(page);
    expect(snap.inlineEditId).toBeNull();
    expect(snap.objectCount).toBe(1);
  });

  test('Text tool: blank click ends edit first; second blank click creates another text', async ({ page }) => {
    await openApp(page);
    await loadBlankPdf(page);
    await openPageEditor(page, 0);
    await createTextAt(page, 0.35, 0.3, 'First');
    expect((await peSnapshot(page)).tool).toBe('text');
    // Ignore the second half of the open-edit gesture (see peInlineEditStartedAt).
    await page.waitForTimeout(500);

    // Product rule: first blank tap only deselects / ends edit (keeps Text tool).
    await clickStage(page, 0.7, 0.7);
    await page.waitForFunction(() => window.__peState && !window.__peState.inlineEditId, null, {
      timeout: 5000,
    });
    let snap = await peSnapshot(page);
    expect(snap.tool).toBe('text');
    expect(snap.objectCount).toBe(1);

    // Second blank tap starts a new text block.
    await clickStage(page, 0.72, 0.72);
    await page.waitForFunction(() => {
      const s = window.__peState;
      return s && s.objects.filter((o) => o.type === 'text').length >= 2;
    }, null, { timeout: 5000 });
    snap = await peSnapshot(page);
    expect(snap.objects.filter((o) => o.type === 'text').length).toBeGreaterThanOrEqual(2);
    expect(snap.inlineEditId).not.toBeNull();
  });
});

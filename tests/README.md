# Playwright e2e (page editor)

Smoke and regression probes for page editing. Not a full product suite.

## Run

```bash
npm ci
npx playwright install chromium
npm run test:e2e
```

HTML report (after a run):

```bash
npm run test:e2e:report
```

## Layout

| Path | Role |
|------|------|
| `playwright.config.mjs` | Chromium + local static server on `:4173` |
| `tests/fixtures/blank-a4.pdf` | Minimal A4 PDF |
| `tests/helpers/app.mjs` | Load PDF / open editor helpers |
| `tests/page-edit.spec.mjs` | Page-editor scenarios |

Tests inject the PDF via `loadPDF(File)` and open the editor with `openPageEditor(0)` to avoid file-picker UI.

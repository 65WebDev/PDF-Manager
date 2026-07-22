# Tauri desktop shell (experimental)

Wraps `PDF_manager_offline.html` in a native Windows window via [Tauri 2](https://v2.tauri.app/).

**This branch is for discussing the Windows shell only.** Editor HTML changes belong in other branches / `main`.

Not published by CI yet — build locally on Windows.

## Full Windows guide (RU)

See **[docs/windows-tauri-build.md](../docs/windows-tauri-build.md)** — установка Git/Node/Rust/Build Tools, `link.exe`, сборка `.exe`, типичные ошибки.

| Command | Purpose |
|---------|---------|
| `npm run build:tauri-ui` | Build offline HTML → `tauri-ui/index.html` |
| `npm run tauri:dev` | Dev window |
| `npm run tauri:build` | Release `.exe` + NSIS installer |

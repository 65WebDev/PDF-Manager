# Tauri desktop shell (experimental)

Wraps `PDF_manager_offline.html` in a native Windows window via [Tauri 2](https://v2.tauri.app/).

**This branch is for discussing the Windows shell only.** Editor HTML changes belong in other branches / `main`.

Not published by CI yet — build locally on Windows.

## Features in this shell

- Offline editor UI inside a native window
- NSIS installer with **`.pdf` file association**
- Open PDF via command line / “Open with” / second-instance handoff (single-instance plugin)

## Full Windows guide (RU)

See **[docs/windows-tauri-build.md](../docs/windows-tauri-build.md)** — установка Git/Node/Rust/Build Tools, `link.exe`, сборка `.exe`, ассоциация PDF, типичные ошибки.

| Command | Purpose |
|---------|---------|
| `npm run build:tauri-ui` | Build offline HTML → `tauri-ui/index.html` (+ open-file bridge) |
| `npm run tauri:dev` | Dev window |
| `npm run tauri:build` | Release `.exe` + NSIS installer |

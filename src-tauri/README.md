# Tauri desktop shell (experimental)

Wraps `PDF_manager_offline.html` in a native Windows window via [Tauri 2](https://v2.tauri.app/).

Not published by CI yet — build locally on Windows (see root README).

| Command | Purpose |
|---------|---------|
| `npm run build:tauri-ui` | Build offline HTML → `tauri-ui/index.html` |
| `npm run tauri:dev` | Dev window |
| `npm run tauri:build` | Release `.exe` + NSIS installer |

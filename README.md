# PDF-Manager

Веб-приложение для работы с PDF-документами в браузере (один HTML-файл, без установки).

## Быстрое скачивание

| Способ | Ссылка |
|--------|--------|
| **Скачать онлайн-версию** | https://github.com/65WebDev/PDF-Manager/releases/latest/download/PDF_manager_online.html |
| **Скачать офлайн-версию** | https://github.com/65WebDev/PDF-Manager/releases/latest/download/PDF_manager_offline.html |
| **Windows: установщик** | https://github.com/65WebDev/PDF-Manager/releases/download/windows-v0.1.17/PDF.Manager_0.1.17_x64-setup.exe |
| **Windows: portable `.exe`** | https://github.com/65WebDev/PDF-Manager/releases/download/windows-v0.1.17/pdf-manager.exe |
| **Linux: `.deb`** | https://github.com/65WebDev/PDF-Manager/releases |
| **Linux: `.AppImage`** | https://github.com/65WebDev/PDF-Manager/releases |
| **Страница релизов (HTML)** | https://github.com/65WebDev/PDF-Manager/releases/latest |
| **Релиз Windows** | https://github.com/65WebDev/PDF-Manager/releases/tag/windows-v0.1.17 |
| **Релиз Linux** | https://github.com/65WebDev/PDF-Manager/releases |
| **Открыть онлайн (GitHub Pages)** | https://65WebDev.github.io/PDF-Manager/ |

После скачивания HTML откройте файл в браузере. Онлайн-версия подгружает библиотеки из CDN; офлайн-версия содержит все зависимости внутри файла.

Десктопная сборка — **отдельные** релизы (`windows-v…`, `linux-v…`), не смешиваются с автоматическими `build-N`. Актуальная версия Windows сейчас: [windows-v0.1.17](https://github.com/65WebDev/PDF-Manager/releases/tag/windows-v0.1.17).

## Как это работает

При каждом обновлении `PDF_manager_online.html` в ветке `main` автоматически:

1. **Создаётся релиз** с пронумерованной сборкой (`build-1`, `build-2`, …) и двумя файлами: онлайн и офлайн.
2. **Собирается офлайн-версия** (`npm run build:offline`) — все CDN-библиотеки и `@cantoo/pdf-lib` встраиваются в `PDF_manager_offline.html`.
3. **Обновляется GitHub Pages** — можно открыть менеджер в браузере или скачать с лендинга.

Прямая ссылка `/releases/latest/download/...` всегда ведёт на **самую свежую HTML-сборку** (`build-N`). Релизы Windows (`windows-v…`) специально **не** помечаются как Latest, чтобы не ломать эти ссылки.

## Ручной запуск

В разделе **Actions** репозитория можно вручную запустить workflow **Release** или **Deploy Pages** (кнопка *Run workflow*).

## Локальная разработка

```bash
git clone https://github.com/65WebDev/PDF-Manager.git
# Откройте PDF_manager_online.html в браузере

# Собрать офлайн-версию локально:
npm ci
npm run build:offline
# Результат: PDF_manager_offline.html
```

## Десктопное приложение (Tauri, экспериментально): Windows + Linux

Оболочка (`src-tauri/`) живёт в `main`, но **не** входит в автоматический release-pipeline — только ручная сборка.

**Подробная инструкция (RU):** [docs/windows-tauri-build.md](docs/windows-tauri-build.md)

### Требования (Windows)

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) (stable, **1.85+**)
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) — workload **«Разработка классических приложений на C++»**
- WebView2 обычно уже есть на Windows 10/11; если нет — установщик подтянет bootstrapper

Проверка окружения после установки:

```bash
rustc --version   # >= 1.85
where link        # должен найти link.exe (Windows)
npm run tauri -- info
```

### Сборка

```bash
git clone https://github.com/65WebDev/PDF-Manager.git
cd PDF-Manager
npm ci

# PowerShell (Windows) — проверка окружения + сборка + upload на GitHub:
#   .\scripts\build-windows-exe.ps1
#   .\scripts\build-windows-exe.ps1 -Local   # без загрузки
#   .\scripts\build-windows-exe.ps1 -Dev
#   .\scripts\build-windows-exe.ps1 -Linux   # + Linux .deb/.AppImage через WSL2, см. docs/windows-tauri-build.md#4a

# Режим разработки (окно + UI из офлайн-HTML):
npm run tauri:dev

# Релизная сборка (.exe + NSIS) и загрузка на GitHub Releases:
npm run tauri:build
# Нужны: GitHub CLI (gh) и `gh auth login`
# Release tag: windows-v{version} из src-tauri/tauri.conf.json
# Без загрузки: npm run tauri:build:local
# или: TAURI_SKIP_UPLOAD=1 npm run tauri:build
# Повторно залить уже собранный exe: npm run tauri:upload
```

Готовые файлы появятся в:

- `src-tauri/target/release/PDF Manager.exe` — запуск без установщика
- `src-tauri/target/release/bundle/nsis/` — установщик `.exe`

`npm run tauri:build` сначала собирает офлайн-HTML (нужен интернет на этом шаге), копирует его в `tauri-ui/index.html` (с мостом открытия PDF), упаковывает в Tauri, затем через `gh` заливает установщик в GitHub Release `windows-v*`. NSIS регистрирует ассоциацию с файлами **`.pdf`**.

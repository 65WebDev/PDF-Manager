# PDF-Manager

Веб-приложение для работы с PDF-документами в браузере (один HTML-файл, без установки).

## Быстрое скачивание

| Способ | Ссылка |
|--------|--------|
| **Скачать онлайн-версию** | https://github.com/5451165-bot/PDF-Manager/releases/latest/download/PDF_manager_online.html |
| **Скачать офлайн-версию** | https://github.com/5451165-bot/PDF-Manager/releases/latest/download/PDF_manager_offline.html |
| **Windows: установщик** | https://github.com/5451165-bot/PDF-Manager/releases/download/windows-v0.1.0/PDF.Manager_0.1.0_x64-setup.exe |
| **Windows: portable `.exe`** | https://github.com/5451165-bot/PDF-Manager/releases/download/windows-v0.1.0/pdf-manager.exe |
| **Страница релизов (HTML)** | https://github.com/5451165-bot/PDF-Manager/releases/latest |
| **Релиз Windows** | https://github.com/5451165-bot/PDF-Manager/releases/tag/windows-v0.1.0 |
| **Открыть онлайн (GitHub Pages)** | https://5451165-bot.github.io/PDF-Manager/ |

После скачивания HTML откройте файл в браузере. Онлайн-версия подгружает библиотеки из CDN; офлайн-версия содержит все зависимости внутри файла.

Десктопная сборка для Windows — **отдельный** релиз (`windows-v…`), не смешивается с автоматическими `build-N`. Актуальная версия сейчас: [windows-v0.1.0](https://github.com/5451165-bot/PDF-Manager/releases/tag/windows-v0.1.0).

## Как это работает

При каждом обновлении `PDF_manager_online.html` в ветке `main` автоматически:

1. **Создаётся релиз** с пронумерованной сборкой (`build-1`, `build-2`, …) и двумя файлами: онлайн и офлайн.
2. **Собирается офлайн-версия** (`npm run build:offline`) — все CDN-библиотеки и `@cantoo/pdf-lib` встраиваются в `PDF_manager_offline.html`.
3. **Обновляется GitHub Pages** — можно открыть менеджер в браузере или скачать с лендинга.

Прямая ссылка `/releases/latest/download/...` всегда ведёт на **самую свежую** сборку.

## Ручной запуск

В разделе **Actions** репозитория можно вручную запустить workflow **Release** или **Deploy Pages** (кнопка *Run workflow*).

## Локальная разработка

```bash
git clone https://github.com/5451165-bot/PDF-Manager.git
# Откройте PDF_manager_online.html в браузере

# Собрать офлайн-версию локально:
npm ci
npm run build:offline
# Результат: PDF_manager_offline.html
```

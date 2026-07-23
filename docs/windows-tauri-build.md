# Сборка Windows‑приложения (Tauri) — инструкция для обсуждения

> Ветка `cursor/tauri-windows-shell-1aac` — **только** про десктопную оболочку и эту инструкцию.  
> Доработки самого редактора (HTML) ведутся отдельно, в других ветках / в `main`.  
> В автоматический release‑pipeline эта сборка **пока не включена**.

## Что получится

После успешной сборки:

| Файл | Путь |
|------|------|
| Запуск без установки | `src-tauri\target\release\PDF Manager.exe` |
| Установщик (NSIS) | `src-tauri\target\release\bundle\nsis\` (например `PDF Manager_0.1.0_x64-setup.exe`) |

Сборка упаковывает **офлайн‑HTML** (`PDF_manager_offline.html`) в окно Tauri + WebView2.

---

## 1. Что установить один раз

### 1.1. Node.js
1. Скачать LTS: https://nodejs.org/ (версия **20+**).
2. Установить с опцией добавления в PATH.
3. Открыть **новый** PowerShell:
```powershell
node -v
npm -v
```

### 1.2. Git
1. Скачать: https://git-scm.com/download/win  
2. На шаге **Adjusting your PATH** выбрать:  
   **Git from the command line and also from 3rd-party software**.
3. Закрыть все окна терминала и открыть новое:
```powershell
git --version
```

Если `git` «не найден», хотя установщик уже запускали:

```powershell
Test-Path "C:\Program Files\Git\cmd\git.exe"
```

Добавить в PATH (пользовательский) и открыть **новый** терминал:

```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  [Environment]::GetEnvironmentVariable("Path", "User") + ";C:\Program Files\Git\cmd",
  "User"
)
```

Либо вручную: *Параметры → Система → О системе → Доп. параметры → Переменные среды → Path* → добавить `C:\Program Files\Git\cmd`.

**Без Git:** можно скачать ZIP ветки и распаковать:  
https://github.com/5451165-bot/PDF-Manager/archive/refs/heads/cursor/tauri-windows-shell-1aac.zip

### 1.3. Rust
1. https://rustup.rs/ → `rustup-init.exe`, установка stable по умолчанию.
2. Новый терминал:
```powershell
rustc --version
cargo --version
```
Нужен Rust **1.85+** (лучше актуальный stable).

### 1.4. Visual C++ Build Tools (обязательно)

Без этого будет ошибка: `linker link.exe not found`.

1. Скачать: https://visualstudio.microsoft.com/visual-cpp-build-tools/
2. В установщике на вкладке **«Рабочие нагрузки»** отметить только:

   **«Разработка классических приложений на C++»**  
   *(Desktop development with C++ — плитка с `++`)*

   Остальное (.NET, Azure, веб) **не нужно**.

3. В правой панели желательно убедиться, что есть:
   - MSVC v143 (или новее) — средства сборки C++ x64/x86  
   - Windows 10/11 SDK  
4. **Установить**, дождаться окончания (несколько ГБ).
5. Полностью закрыть терминалы (иногда помогает перезагрузка ПК).

Проверка:

```powershell
where.exe link
```

Должен появиться путь к `link.exe` внутри `Microsoft Visual Studio\...\MSVC\...\link.exe`.

Если пусто — открыть из меню Пуск **«x64 Native Tools Command Prompt for VS 2022»** или **«Developer PowerShell for VS 2022»** и собирать уже оттуда.

### 1.5. WebView2
На Windows 10/11 обычно уже есть. Если приложение не стартует из‑за WebView2:  
https://developer.microsoft.com/microsoft-edge/webview2/

---

## 2. Скачать код этой ветки

```powershell
git clone https://github.com/5451165-bot/PDF-Manager.git
cd PDF-Manager
git fetch origin
git checkout cursor/tauri-windows-shell-1aac
```

---

## 3. Зависимости npm

```powershell
npm ci
```

Проверка окружения Tauri:

```powershell
npm run tauri -- info
```

---

## 4. Сборка `.exe`

Нужен **интернет** (скачивание CDN‑библиотек для офлайн‑HTML + crates Rust).

Также нужен [GitHub CLI](https://cli.github.com/) и авторизация (`gh auth login`) — после сборки установщик **автоматически** заливается в GitHub Release.

```powershell
npm run tauri:build
```

Что происходит:

1. `npm run build:offline` → `PDF_manager_offline.html`  
2. Копия в `tauri-ui\index.html` + мост для открытия PDF из ОС  
3. `tauri build` → `PDF Manager.exe` + NSIS‑установщик с ассоциацией `.pdf`  
4. `scripts/upload-windows-installer.mjs` → GitHub Release `windows-v{version}`  

Первая сборка часто занимает **10–20+ минут**. Повторные быстрее (кэш).

Полезные варианты:

```powershell
# Сборка без загрузки на GitHub:
npm run tauri:build:local
# или
$env:TAURI_SKIP_UPLOAD="1"; npm run tauri:build

# Только повторно залить уже собранные .exe:
npm run tauri:upload
```

### Режим разработки (без установщика)

```powershell
npm run tauri:dev
```

Проверка ассоциации в dev (без установщика):

```powershell
npm run tauri:dev
# в другом окне, подставьте свой путь:
& "src-tauri\target\debug\PDF Manager.exe" "C:\path\to\file.pdf"
```

Или после релизной сборки:

```powershell
& "src-tauri\target\release\PDF Manager.exe" "C:\path\to\file.pdf"
```

---

## 5. Ассоциация с PDF (установщик)

NSIS‑установщик регистрирует приложение как обработчик **`.pdf`** (`bundle.fileAssociations`).

После установки:

1. ПКМ по PDF → **Открыть с помощью** → **PDF Manager**  
2. Или: Параметры Windows → Приложения → **Приложения по умолчанию** → выбрать PDF Manager для `.pdf`

При двойном клике (если PDF Manager выбран по умолчанию) или «Открыть с помощью» файл передаётся в уже запущенное окно (один экземпляр) либо открывает приложение с этим файлом.

> Windows может не дать стать «единственным» просмотрщиком без согласия пользователя — это ограничение системы, не баг установщика.

---

## 6. Частые ошибки

| Симптом | Что сделать |
|---------|-------------|
| `git` / `node` / `rustc` не найдены | PATH; новый терминал после установки |
| `linker link.exe not found` | Установить workload **«Разработка классических приложений на C++»**, новый терминал |
| Ошибка на `build:offline` / fetch | Интернет или блокировка CDN (unpkg, cdnjs, jsdelivr) |
| Долго `Updating crates.io` / Downloading crates | Нормально на первом запуске |
| Антивирус ругается на `.exe` | Типично для неподписанной сборки; разрешить для своего теста |
| VS Code установлен, а `link.exe` нет | VS Code ≠ Build Tools; нужен отдельный установщик Build Tools |
| PDF не открывается из проводника | Обновите ветку и пересоберите: раньше путь `C:\...` ошибочно отбрасывался. Проверьте также запуск с путём в кавычках. |
| `Permission allow-… not found` | Обновите ветку (`git pull`) — нужны файлы в `src-tauri/permissions/` |
| `gh` не найден / не авторизован при upload | В том же терминале: `gh api user --jq .login` — должен показать логин. Если ок, обновите ветку (`git pull`) — исправлен вызов gh из npm на Windows. Иначе `gh auth login`. Сборка без upload: `npm run tauri:build:local` |

---

## 7. Краткий чеклист

1. Node 20+, Git, Rust 1.85+, Build Tools (**C++**)  
2. `git checkout cursor/tauri-windows-shell-1aac`  
3. `npm ci`  
4. `where.exe link` — команда что‑то находит  
5. `npm run tauri:build`  
6. Запустить `src-tauri\target\release\PDF Manager.exe`  
7. Установить NSIS‑сборку и проверить «Открыть с помощью» для PDF  

---

## Связанные ссылки

- PR (обсуждение оболочки): https://github.com/5451165-bot/PDF-Manager/pull/23  
- Ветка: `cursor/tauri-windows-shell-1aac`  
- Официальные prerequisites Tauri: https://v2.tauri.app/start/prerequisites/

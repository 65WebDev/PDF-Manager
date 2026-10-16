# Сборка Windows‑, Linux‑ и Android‑приложения (Tauri)

> Десктопная оболочка (Tauri, `src-tauri/`) живёт прямо в `main`.  
> В автоматический release‑pipeline (`build-N`, HTML‑релизы) эта сборка **не включена** — только ручной запуск.

## Что получится

После успешной сборки:

| Файл | Путь |
|------|------|
| Windows: запуск без установки | `src-tauri\target\release\PDF Manager.exe` |
| Windows: установщик (NSIS) | `src-tauri\target\release\bundle\nsis\` (например `PDF Manager_0.1.15_x64-setup.exe`) |
| Linux: пакет `.deb` | `dist-linux\*.deb` |
| Linux: `.AppImage` | `dist-linux\*.AppImage` |
| Android: `.apk` | `dist-android\PDF-Manager_{версия}.apk` (раздел 4b) |

Сборка упаковывает **офлайн‑HTML** (`PDF_manager_offline.html`) в окно Tauri + WebView2 (Windows) / WebKitGTK (Linux) / Android System WebView (Android).

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
https://github.com/65WebDev/PDF-Manager/archive/refs/heads/cursor/tauri-windows-shell-1aac.zip

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

Если пусто — не обязательно сразу переустанавливать. Часто Build Tools уже стоят, но **не в PATH** обычного PowerShell:

1. Запустите из меню Пуск **«Developer PowerShell for VS 2022»** (или **«x64 Native Tools Command Prompt for VS 2022»**) и соберите оттуда; **или**
2. Обновите `scripts\build-windows-exe.ps1` — скрипт сам подхватывает окружение через `vswhere` + `VsDevCmd.bat`.

Быстрая установка через winget (workload C++):

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

После установки — **новый** терминал.

### 1.5. WebView2
На Windows 10/11 обычно уже есть. Если приложение не стартует из‑за WebView2:  
https://developer.microsoft.com/microsoft-edge/webview2/

---

## 2. Скачать код

```powershell
git clone https://github.com/65WebDev/PDF-Manager.git
cd PDF-Manager
```

(`src-tauri/` уже в `main` — отдельную ветку переключать не нужно.)

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

### Быстрый способ (PowerShell)

Из корня репозитория:

```powershell
# Сборка + загрузка установщика/portable в GitHub Release (по умолчанию):
# Нужны: gh (GitHub CLI) и `gh auth login`
# Перед сборкой скрипт сам делает fetch/checkout/pull latest origin/main.
.\scripts\build-windows-exe.ps1

# Только локальная сборка, без GitHub:
.\scripts\build-windows-exe.ps1 -Local

# Зависимости уже стоят:
.\scripts\build-windows-exe.ps1 -SkipNpmCi

# Не обновлять git (собрать текущее дерево как есть):
.\scripts\build-windows-exe.ps1 -SkipGitSync

# Папка только для сборки / ярлык: сбросить локальные правки и взять latest main:
.\scripts\build-windows-exe.ps1 -Force

# Не поднимать Windows-semver автоматически (оставить текущий tag / clobber):
.\scripts\build-windows-exe.ps1 -NoBump

# Режим разработки:
.\scripts\build-windows-exe.ps1 -Dev

# Windows-установщик И Linux .deb/.AppImage за один запуск (через WSL2):
.\scripts\build-windows-exe.ps1 -Linux

# Только Linux-сборка, без пересборки Windows (см. раздел 4a):
.\scripts\build-windows-exe.ps1 -LinuxOnly -Local
```

Перед upload-сборкой (без `-Local` / `-NoBump`) скрипт проверяет GitHub:
если релиз `windows-v{version}` уже есть **и** на `main` есть коммиты после этого тега —
patch-версия в `tauri.conf.json` + `Cargo.toml` поднимается автоматически
(например `0.1.9` → `0.1.10`), коммит пушится в `main`, затем собирается
новый tag `windows-v0.1.10`. Upload также обновит `version.json` / README / лендинг.

Если PowerShell блокирует скрипт:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\build-windows-exe.ps1
```

Скрипт можно положить и в **корень** репозитория (`.\build-windows-exe.ps1`) — корень ищется по `package.json`.

> Windows PowerShell 5.1: файл должен быть в **UTF-8 с BOM** (так и сохранён в репозитории). Если копируете текст вручную в Блокнот — «Сохранить как» → кодировка **UTF-8**.

Release tag: `windows-v{version}` из `src-tauri/tauri.conf.json` (сейчас, например, `windows-v0.1.9`).

При открытии PDF (ассоциация файла, «Открыть с помощью», DnD из Проводника, выбор файла в приложении) окно **разворачивается** (maximize), не exclusive fullscreen.

### Вручную через npm

Также нужен [GitHub CLI](https://cli.github.com/) и авторизация (`gh auth login`) — после сборки установщик **автоматически** заливается в GitHub Release (только для `tauri:build`, не для `tauri:build:local`).

```powershell
npm run tauri:build
```

Что происходит:

1. `npm run build:offline` → `PDF_manager_offline.html`  
2. Копия в `tauri-ui\index.html` + мост для открытия PDF из ОС  
3. `tauri build` → `PDF Manager.exe` + NSIS‑установщик с ассоциацией `.pdf`  
4. `scripts/upload-windows-installer.mjs` → GitHub Release `windows-v{version}` и синхронизация описания:
   - notes релиза со ссылками на установщик / portable  
   - ссылки Windows в `README.md` (commit + push)  
   - `version-feed` (поле `windowsVersion` для «О программе»)  
   - описание репозитория на GitHub (если есть права admin)  

Чтобы только залить `.exe` без правки README: `$env:SKIP_README_COMMIT="1"`.

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

## 4a. Linux (`.deb` / `.AppImage`) через WSL2 — с той же Windows-машины

`build-windows-exe.ps1 -Linux` собирает Linux-пакеты **в дополнение** к Windows,
одним запуском, без отдельной Linux-машины: Windows не умеет кросс-компилировать
Tauri под Linux напрямую (нужен настоящий Linux с webkit2gtk), поэтому скрипт
прогоняет `scripts/build-linux.sh` внутри WSL2 — с тем же коммитом, что и Windows-сборка.

### Once: установить WSL2 + окружение внутри него

```powershell
# В обычном PowerShell (не WSL), один раз:
wsl --install -d Ubuntu
# Перезагрузка, затем открыть Ubuntu из меню Пуск один раз (создать пользователя).
```

Внутри WSL2 (Ubuntu) один раз поставить Node и Rust — так же, как на обычном Linux:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
curl https://sh.rustup.rs -sSf | sh -s -- -y
source "$HOME/.cargo/env"
```

Системные библиотеки (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev` и т.д.) ставить
отдельно **не нужно** — `build-linux.sh` сам проверяет и ставит недостающие
через `apt-get` (спросит sudo-пароль при первом запуске).

### Сборка

```powershell
# Windows-установщик + Linux .deb/.AppImage за один запуск:
.\scripts\build-windows-exe.ps1 -Linux

# Только Linux, без пересборки Windows (быстрее при итерациях):
.\scripts\build-windows-exe.ps1 -LinuxOnly -Local

# Явно указать дистрибутив WSL, если их несколько:
.\scripts\build-windows-exe.ps1 -Linux -WslDistro Ubuntu
```

Готовые файлы: `dist-linux\*.deb` и `dist-linux\*.AppImage` (в корне репозитория,
видны прямо из Windows — папка не коммитится, есть в `.gitignore`).

Первая Linux-сборка (crates.io + AppImage-тулинг) занимает **10–20+ минут**,
как и первая Windows-сборка. Внутри WSL2 сборка идёт в отдельном клоне
(`~/pdf-manager-linux-build` в файловой системе WSL, не на `/mnt/c`) — так
заметно быстрее и без проблем с блокировкой файлов Cargo через 9p-мост.

По умолчанию (без `-Local`) сборка **также заливается** в GitHub Release
`linux-v{version}` — аналогично Windows, но своим тегом (нужен тот же
`gh auth login`, что и для Windows-загрузки; выполняется из PowerShell,
`dist-linux/` видна оттуда). Только локально, без загрузки:

```powershell
.\scripts\build-windows-exe.ps1 -Linux -Local
.\scripts\build-windows-exe.ps1 -LinuxOnly -Local
```

`.deb` ставится через `sudo apt install ./dist-linux/*.deb` (или двойным
кликом в файловом менеджере), `.AppImage` — `chmod +x` и запуск напрямую.

Bundle-таргеты Linux заданы отдельно от Windows, в `src-tauri/tauri.linux.conf.json`
(Tauri сам подмешивает `tauri.<platform>.conf.json` поверх `tauri.conf.json`
по целевой платформе) — правки NSIS/Windows в основном `tauri.conf.json` этот
файл не затрагивает.

---

## 4b. Android (`.apk`) — на той же Windows-машине

APK для телефонов и планшетов на ARM (64- и 32-битных), Android 7.0 и новее.
Собирается тем же скриптом: `-Android` (вместе с Windows-сборкой) или
`-AndroidOnly` (только APK). Без `-Local` APK заливается в GitHub Release
`android-v{version}`, обновляются лента версий (проверка обновлений в
«О программе» на телефоне), README и `index.html` — так же, как для Linux.

Что умеет версия для Android:

- открывает PDF из других приложений: «Открыть с помощью» (файловый
  менеджер, почта, мессенджер) и «Поделиться» → PDF Manager — в том числе
  несколько файлов сразу;
- **Сохранить** / **Экспорт** — через системный диалог «Сохранить как»
  (можно выбрать папку на телефоне, SD-карту, Google Диск и т. п.);
  «Сохранить по страницам» спрашивает папку один раз;
- кнопка **«Поделиться»** (первый ряд, после «Режима чтения») — системное
  меню «Поделиться»: документ в том виде, в каком его записал бы «Сохранить»
  (порядок страниц, без помеченных на удаление, с правками), но без сохранения;
- кнопка **«Печать»** (второй ряд) — системный диалог печати (принтеры,
  «Сохранить как PDF»); печать выделенных страниц — в меню страницы
  (долгое нажатие);
- режим чтения скрывает строку состояния и панель навигации;
- кнопка «Назад» закрывает открытое (диалог, редактор страницы, поиск,
  режим чтения), а если ничего не открыто — сворачивает приложение
  (документ не теряется).

Файл, открытый из другого приложения, — это копия в кэше приложения,
поэтому «Сохранить» всегда спрашивает, куда записать (поверх исходного
файла не пишет).

### Один раз: установить и настроить

1. **Android Studio**: https://developer.android.com/studio — установить с
   настройками по умолчанию, запустить один раз (мастер скачает SDK).
2. В Android Studio: **More Actions → SDK Manager** (или Settings →
   Languages & Frameworks → **Android SDK**):
   - вкладка **SDK Platforms** — отметить **Android 16 (API 36)**;
   - вкладка **SDK Tools** — отметить **NDK (Side by side)**,
     **Android SDK Build-Tools**, **Android SDK Command-line Tools (latest)**,
     **Android SDK Platform-Tools**;
   - **Apply** и дождаться загрузки. Вверху окна виден путь
     **Android SDK Location** — обычно `C:\Users\<вы>\AppData\Local\Android\Sdk`.
3. Переменные среды (PowerShell, один раз; если путь к SDK другой —
   подставьте его):

   ```powershell
   [Environment]::SetEnvironmentVariable("JAVA_HOME", "C:\Program Files\Android\Android Studio\jbr", "User")
   [Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LocalAppData\Android\Sdk", "User")
   $ndk = Get-ChildItem "$env:LocalAppData\Android\Sdk\ndk" -Directory | Sort-Object Name | Select-Object -Last 1
   $ndk.FullName   # должен вывести ...\Sdk\ndk\<версия>
   [Environment]::SetEnvironmentVariable("NDK_HOME", $ndk.FullName, "User")
   ```

   Если `Get-ChildItem` пишет «не удаётся найти путь …\Sdk\ndk» — NDK ещё не
   установлен (пункт 2, **NDK (Side by side)**). Скрипт сборки, кстати, сам
   найдёт самый новый NDK в SDK, если `NDK_HOME` не задан.

   Затем **новое** окно PowerShell и проверка (все три — `True`):

   ```powershell
   Test-Path "$env:JAVA_HOME\bin\java.exe"
   Test-Path "$env:ANDROID_HOME\platform-tools"
   Test-Path "$env:NDK_HOME\source.properties"
   ```

4. Rust-цели для Android скрипт добавляет сам (`rustup target add
   aarch64-linux-android armv7-linux-androideabi`).

### Один раз: ключ подписи (только у вас, не в репозитории)

Android ставит только подписанные APK, а **обновление** приложения — только
подписанное тем же ключом. Ключ создаётся один раз:

```powershell
mkdir "$env:USERPROFILE\keys" -Force
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v `
  -keystore "$env:USERPROFILE\keys\pdf-manager-release.jks" `
  -alias pdf-manager -keyalg RSA -keysize 2048 -validity 10000
```

keytool спросит пароль и данные владельца (имя можно любое). Затем создайте
файл `src-tauri\gen\android\keystore.properties` (он в `.gitignore` и в git не
попадёт):

```properties
storeFile=C:/Users/<вы>/keys/pdf-manager-release.jks
storePassword=<пароль хранилища>
keyAlias=pdf-manager
keyPassword=<пароль ключа (обычно тот же)>
```

Путь — с **прямыми** слешами `/` (обратные в `.properties` надо удваивать).

> **Сохраните `.jks` и пароли в надёжном месте (резервная копия).** Потеряв
> ключ, выпустить обновление уже установленного приложения нельзя — только
> удалить и поставить заново. Для Google Play этот же ключ потом станет
> «ключом загрузки» (upload key).

### Сборка

```powershell
# Только APK + загрузка в GitHub Release android-v{version}:
.\scripts\build-windows-exe.ps1 -AndroidOnly

# Только APK, без GitHub (файл в dist-android\):
.\scripts\build-windows-exe.ps1 -AndroidOnly -Local

# Windows + Android (и Linux) за один запуск:
.\scripts\build-windows-exe.ps1 -Android
.\scripts\build-windows-exe.ps1 -Linux -Android
```

Версия APK — из `src-tauri\tauri.conf.json` (та же, что у Windows/Linux;
поднимает её Windows-сборка). Первая сборка — **15–30+ минут** (Rust для двух
целей + Gradle скачивает зависимости), следующие быстрее.

Без `keystore.properties` локальная сборка (`-Local`) даёт **неподписанный**
APK (поставить его нельзя), а сборка с загрузкой останавливается с
подсказкой.

Вручную, без скрипта: `npx tauri android build --apk --target aarch64 --target armv7`
→ `src-tauri\gen\android\app\build\outputs\apk\universal\release\`.

### Установка на телефон

Скопируйте APK на телефон (или скачайте со страницы релиза) и откройте его.
Android попросит разрешить установку из этого источника (браузер / файловый
менеджер) — разрешите. Обновление: поставить новый APK поверх (тот же ключ).

### Тестовая сборка в GitHub Actions

Workflow **Android APK** (`.github/workflows/android.yml`) собирает APK
на каждый PR, который меняет `src-tauri/` или мост Tauri, и вручную:
**Actions → Android APK → Run workflow**. Готовый APK — в разделе
**Artifacts** запуска.

Подпись там:

- если в **Settings → Secrets and variables → Actions** заданы секреты
  `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
  `ANDROID_KEY_PASSWORD` — вашим ключом (такой APK обновляет установленный);
- иначе — одноразовым тестовым ключом: APK ставится, но поверх него ваш
  релиз встанет только после удаления тестового.

Секреты репозитория видны только Actions (их нельзя прочитать обратно ни в
интерфейсе, ни из логов). Строка для `ANDROID_KEYSTORE_BASE64`:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\keys\pdf-manager-release.jks")) | Set-Clipboard
```

### Как устроено

- `src-tauri\gen\android\` — Android-проект (Gradle), создан `tauri android init`
  и хранится в git; всё, что сборка генерирует в нём, — в `.gitignore`.
- `src-tauri\tauri.android.conf.json` — идентификатор `io.github.pdfmanager`,
  minSdk 24; `fileAssociations` для Android отключены — фильтры «Открыть с
  помощью» / «Поделиться» прописаны в `AndroidManifest.xml` явно.
- `src-tauri\src\android.rs` + `PdfBridgePlugin.kt` — мост к Android
  (файлы из других приложений, «Сохранить как», выбор папки, «Поделиться»,
  печать, полный экран, ссылки); `scripts\prepare-tauri-ui.mjs` — его часть
  в UI (активна только на Android).
- Подпись — `app\build.gradle.kts`: `keystore.properties` или переменные
  `PM_ANDROID_KEYSTORE*` (так её получает GitHub Actions).

---

## 5. Ассоциация с PDF (установщик)

NSIS‑установщик регистрирует приложение как обработчик **`.pdf`** (`bundle.fileAssociations`).

После установки:

1. ПКМ по PDF → **Открыть с помощью** → **PDF Manager**  
2. Или: Параметры Windows → Приложения → **Приложения по умолчанию** → выбрать PDF Manager для `.pdf`

При двойном клике (если PDF Manager выбран по умолчанию) или «Открыть с помощью» файл передаётся в уже запущенное окно (один экземпляр) либо открывает приложение с этим файлом.

> Windows может не дать стать «единственным» просмотрщиком без согласия пользователя — это ограничение системы, не баг установщика.

### Язык установщика (EN / RU)

В `tauri.conf.json` → `bundle.windows.nsis.languages` включены **English** и **Russian**. Диалог выбора языка выключен (`displayLanguageSelector: false`): установщик берёт язык интерфейса Windows (`GetUserDefaultUILanguage`), а если его нет в списке — первый язык (**English**). Повторная установка / удаление используют сохранённый в реестре выбор (`Installer Language`).

### Обновление поверх текущей версии

Штатный NSIS Tauri при новой версии по умолчанию предлагает **удалить** старую установку. У нас подключён шаблон `src-tauri/windows/installer.nsi`: при **повышении** версии установщик ставит файлы **поверх** (как флаг `/UPDATE`), без шага удаления. Ярлыки и данные приложения сохраняются. Повторная установка той же версии по-прежнему показывает меню обслуживания.

---

## 6. Частые ошибки

| Симптом | Что сделать |
|---------|-------------|
| `git` / `node` / `rustc` не найдены | PATH; новый терминал после установки |
| В About старый `build-N` (например 103 вместо 105) | Номер **редактора** берётся из `version.json` / `version-feed.js` при `build:tauri-ui`. Сделайте `git pull`, убедитесь что в `version.json` нужный `build`, пересоберите. Скрипт **всегда** перезаписывает stamp. В логе: `About secondary (editor build):` / `Wrote tauri-ui … build-…`. |
| В About старая версия приложения (0.1.x), хотя собрали новую | В десктопе основная строка — **Windows-пакет** из `tauri.conf.json` (не `build-N`). После bump/`tauri build` в логе должно быть `Wrote tauri-ui … (Windows 0.1.x, …)`. Если штамп не совпал, `build:tauri-ui` падает. Переустановите NSIS поверх; при пустом штампе About подтягивает версию через Tauri `getVersion()`. |
| `git push` rejected при auto-bump (`Version files were committed locally but not pushed`) | На `main` успел приехать другой коммит (часто `version feed`). Скрипт теперь делает rebase+retry. Если всё же упало: `git pull --rebase origin main` → `git push origin HEAD`, либо `.\scripts\build-windows-exe.ps1 -Force` (сбросит локальный bump и начнёт заново). |
| После `tauri:build` README/лендинг всё ещё на старой Windows-версии | Скрипт upload должен обновить README, `index.html`, `version.json` и запушить. Нужен `git` в PATH и `gh auth`. Без upload (`-Local`) метаданные не обновляются. |
| `linker link.exe not found` | Установить workload **«Разработка классических приложений на C++»**, новый терминал |
| Ошибка на `build:offline` / fetch | Интернет или блокировка CDN (unpkg, cdnjs, jsdelivr) |
| Долго `Updating crates.io` / Downloading crates | Нормально на первом запуске |
| Антивирус ругается на `.exe` | Типично для неподписанной сборки; разрешить для своего теста |
| VS Code установлен, а `link.exe` нет | VS Code ≠ Build Tools; нужен отдельный установщик Build Tools |
| PDF не открывается из проводника | Обновите ветку и пересоберите: раньше путь `C:\...` ошибочно отбрасывался. Проверьте также запуск с путём в кавычках. |
| `Permission allow-… not found` | Обновите ветку (`git pull`) — нужны файлы в `src-tauri/permissions/` |
| `gh` не найден / не авторизован при upload | В том же терминале: `gh api user --jq .login` — должен показать логин. Если ок, обновите ветку (`git pull`) — исправлен вызов gh из npm на Windows. Иначе `gh auth login`. Сборка без upload: `npm run tauri:build:local` |
| Ярлык / иконка приложения «старая», хотя версия новая | Нужна сборка **≥ 0.1.2** (`npm run tauri:build`), затем **переустановка** установщиком. В 0.1.2 ярлык и ассоциация `.pdf` берут версионированный `.ico` (ломает кэш Windows). Если всё ещё старое: удалите ярлык с рабочего стола вручную, переустановите; либо `ie4uinit.exe -show` / перезапуск Explorer. |
| Обновление удаляет старую версию перед установкой | Со сборкой с `windows/installer.nsi` (in-place upgrade) новая версия ставится **поверх** без шага «удалить текущую». Повторная установка той же версии по-прежнему предлагает обслуживание / удаление. |
| Иконка на панели задач размыта | В 0.1.2 пересобраны размеры 16–256 (BMP) с лёгким sharpen. После установки проверьте при 100% масштабе Windows; при 150%+ нужна именно новая сборка. |
| Нельзя перетащить PDF из Проводника в окно | Нужна сборка **≥ 0.1.3**. В ней включён нативный Tauri `onDragDropEvent` (HTML5 DnD в WebView2 на Windows с `dragDropEnabled:false` оказался ненадёжен). `git pull` → `npm run tauri:build` → переустановите NSIS. |
| Индикатор вставки / курсор DnD «уезжает» вправо-вниз | Нужна сборка **≥ 0.1.4** — координаты drop переводятся из physical pixels в CSS через `scaleFactor` (масштаб Windows 125%/150%). |
| Нет «призраков» вкладок / разделителя / подсветки «Объединить» при DnD | Нужна сборка **≥ 0.1.5** — мост Tauri сам hit-test’ит панель вкладок и кнопку «Объединить» (HTML5 `dragover`/`drop` при native DnD не приходят). |
| В окне «Порядок объединения» нельзя переставить строки | Нужна сборка **≥ 0.1.6** — при Tauri native DnD HTML5 `draggable` в WebView2 не работает; сортировка переведена на pointer-события. |
| `wsl.exe not found` при `-Linux` | Установить WSL2: `wsl --install -d Ubuntu`, перезагрузка, открыть Ubuntu один раз из Пуск. |
| `No WSL2 distro installed` | Тот же `wsl --install -d Ubuntu`; список установленных — `wsl -l -v`. |
| Внутри WSL: `rustc`/`node` не найдены | Поставить их **внутри WSL** (не путать с Windows-версиями) — см. раздел 4a «Once». |
| Linux-сборка просит sudo-пароль на каждый запуск | Нормально при первом запуске (доустановка apt-пакетов). Если пакеты уже стоят, `build-linux.sh` больше `apt-get` не вызывает. |
| `.AppImage` не запускается («permission denied») | `chmod +x dist-linux/*.AppImage` перед запуском — GitHub/Windows не сохраняют исполняемый бит. |
| `-Android`: `JAVA_HOME is not set to a JDK` / `ANDROID_HOME …` / `Android NDK not found` | Раздел 4b «Один раз»: Android Studio + SDK Manager (NDK), переменные среды, **новое** окно PowerShell. |
| `-Android`: `Get-ChildItem … \Sdk\ndk … не существует` при настройке | NDK не установлен: SDK Manager → SDK Tools → **NDK (Side by side)** → Apply; затем повторить команду с `NDK_HOME`. |
| `-Android`: `No signing key` | Нет `src-tauri\gen\android\keystore.properties` — создать ключ и файл (раздел 4b) или собрать с `-Local`. |
| Gradle: `SDK location not found` / нет `platforms;android-36` | SDK Manager → SDK Platforms → **Android 16 (API 36)**; проверить `ANDROID_HOME`. |
| Gradle: `Keystore file … not found` / `wrong password` | Путь в `keystore.properties` с прямыми слешами `/`, пароли без кавычек. |
| Телефон: «Приложение не установлено» при обновлении | APK подписан другим ключом (например, тестовая сборка из Actions) — удалить старое приложение и поставить заново. |

---

## 7. Краткий чеклист

1. Node 20+, Git, Rust 1.85+, Build Tools (**C++**)  
2. `git clone` / `git pull` — код уже в `main`  
3. `.\scripts\build-windows-exe.ps1` (или `npm ci` + `npm run tauri:build:local`)  
4. `where.exe link` — команда что‑то находит (скрипт проверяет сам)  
5. Запустить `src-tauri\target\release\PDF Manager.exe`  
6. Установить NSIS‑сборку и проверить «Открыть с помощью» для PDF  
7. Заодно и Linux (`.deb`/`.AppImage`)? `.\scripts\build-windows-exe.ps1 -Linux` (нужен WSL2, см. раздел 4a)  
8. Android (`.apk`)? Android Studio + ключ подписи (раздел 4b), затем `.\scripts\build-windows-exe.ps1 -AndroidOnly`  

---

## Связанные ссылки

- PR (обсуждение оболочки): https://github.com/65WebDev/PDF-Manager/pull/23  
- Ветка: `cursor/tauri-windows-shell-1aac`  
- Официальные prerequisites Tauri: https://v2.tauri.app/start/prerequisites/

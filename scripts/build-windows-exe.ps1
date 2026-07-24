#Requires -Version 5.1
<#
.SYNOPSIS
  Сборка Windows .exe (Tauri) для PDF Manager.

.DESCRIPTION
  Проверяет окружение (Node, Rust, MSVC link.exe), при необходимости
  ставит npm-зависимости и запускает релизную сборку.

  После успеха:
    - portable:  src-tauri\target\release\PDF Manager.exe
    - установщик: src-tauri\target\release\bundle\nsis\*.exe

  Подробности: docs\windows-tauri-build.md

.PARAMETER Upload
  После сборки залить установщик в GitHub Release (нужны gh + auth login).
  Без этого флага — только локальная сборка (npm run tauri:build:local).

.PARAMETER SkipNpmCi
  Не запускать npm ci (если node_modules уже установлены).

.PARAMETER Dev
  Вместо релизной сборки запустить npm run tauri:dev.

.EXAMPLE
  .\scripts\build-windows-exe.ps1

.EXAMPLE
  .\scripts\build-windows-exe.ps1 -Upload

.EXAMPLE
  .\scripts\build-windows-exe.ps1 -SkipNpmCi
#>

[CmdletBinding()]
param(
  [switch] $Upload,
  [switch] $SkipNpmCi,
  [switch] $Dev
)

$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

function Write-Step([string] $Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string] $Message) {
  Write-Host "OK  $Message" -ForegroundColor Green
}

function Write-Fail([string] $Message) {
  Write-Host "ERR $Message" -ForegroundColor Red
}

function Test-Command([string] $Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Assert-Command([string] $Name, [string] $Hint) {
  if (-not (Test-Command $Name)) {
    Write-Fail "$Name не найден в PATH."
    Write-Host $Hint -ForegroundColor Yellow
    exit 1
  }
  $ver = & $Name --version 2>$null
  if (-not $ver) { $ver = & $Name -v 2>$null }
  if ($ver) {
    $first = ($ver | Select-Object -First 1).ToString().Trim()
    Write-Ok "$Name — $first"
  } else {
    Write-Ok "$Name найден"
  }
}

# Корень репозитория (скрипт лежит в scripts\)
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $RepoRoot
Write-Host "Репозиторий: $RepoRoot" -ForegroundColor DarkGray

# --- Проверки окружения -------------------------------------------------
Write-Step "Проверка окружения"

Assert-Command 'node' @"
Установите Node.js 20+ LTS: https://nodejs.org/
После установки откройте НОВЫЙ PowerShell.
"@

Assert-Command 'npm' @"
npm обычно ставится вместе с Node.js. Откройте новый терминал после установки.
"@

Assert-Command 'rustc' @"
Установите Rust (stable): https://rustup.rs/
Нужен Rust 1.85+. После rustup-init.exe — новый терминал.
"@

Assert-Command 'cargo' @"
cargo ставится вместе с Rust (rustup). Новый терминал после установки.
"@

$link = Get-Command link.exe -ErrorAction SilentlyContinue
if (-not $link) {
  Write-Fail "link.exe не найден (Visual C++ Build Tools)."
  Write-Host @"
Установите Build Tools:
  https://visualstudio.microsoft.com/visual-cpp-build-tools/
Workload: «Разработка классических приложений на C++»
  (Desktop development with C++)

Затем откройте новый терминал или «Developer PowerShell for VS 2022»
и снова запустите этот скрипт.
"@ -ForegroundColor Yellow
  exit 1
}
Write-Ok "link.exe — $($link.Source)"

if ($Upload) {
  Assert-Command 'gh' @"
Для -Upload нужен GitHub CLI: https://cli.github.com/
Затем: gh auth login
Либо соберите без загрузки: .\scripts\build-windows-exe.ps1
"@
  try {
    $login = gh api user --jq .login 2>$null
    if (-not $login) { throw 'not logged in' }
    Write-Ok "gh — авторизован как $login"
  } catch {
    Write-Fail "gh не авторизован. Выполните: gh auth login"
    exit 1
  }
}

# --- npm зависимости ----------------------------------------------------
if (-not $SkipNpmCi) {
  Write-Step "npm ci"
  npm ci
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Ok "зависимости установлены"
} else {
  Write-Step "npm ci пропущен (-SkipNpmCi)"
  if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
    Write-Fail "node_modules нет. Уберите -SkipNpmCi или выполните npm ci."
    exit 1
  }
}

# --- Сборка / dev -------------------------------------------------------
if ($Dev) {
  Write-Step "Режим разработки: npm run tauri:dev"
  Write-Host "Окно откроется после компиляции. Остановка: Ctrl+C" -ForegroundColor DarkGray
  npm run tauri:dev
  exit $LASTEXITCODE
}

if ($Upload) {
  Write-Step "Релизная сборка + загрузка на GitHub (npm run tauri:build)"
  Write-Host "Первая сборка может занять 10–20+ минут." -ForegroundColor DarkGray
  npm run tauri:build
} else {
  Write-Step "Релизная сборка без upload (npm run tauri:build:local)"
  Write-Host "Первая сборка может занять 10–20+ минут." -ForegroundColor DarkGray
  npm run tauri:build:local
}

if ($LASTEXITCODE -ne 0) {
  Write-Fail "Сборка завершилась с кодом $LASTEXITCODE"
  Write-Host "См. docs\windows-tauri-build.md — раздел «Частые ошибки»." -ForegroundColor Yellow
  exit $LASTEXITCODE
}

# --- Результат ----------------------------------------------------------
Write-Step "Готово"

$portable = Join-Path $RepoRoot 'src-tauri\target\release\PDF Manager.exe'
$nsisDir = Join-Path $RepoRoot 'src-tauri\target\release\bundle\nsis'

if (Test-Path $portable) {
  Write-Ok "Portable: $portable"
} else {
  Write-Fail "Не найден: $portable"
}

if (Test-Path $nsisDir) {
  $setup = Get-ChildItem -Path $nsisDir -Filter '*.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($setup) {
    Write-Ok "Установщик: $($setup.FullName)"
  } else {
    Write-Host "Папка NSIS есть, но .exe установщика не найден: $nsisDir" -ForegroundColor Yellow
  }
} else {
  Write-Host "Папка NSIS ещё не создана: $nsisDir" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Запуск portable:" -ForegroundColor DarkGray
Write-Host "  & `"$portable`"" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Документация: docs\windows-tauri-build.md" -ForegroundColor DarkGray

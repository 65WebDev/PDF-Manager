#Requires -Version 5.1
<#
.SYNOPSIS
  Build Windows .exe (Tauri) for PDF Manager.

.DESCRIPTION
  Checks Node / Rust / MSVC link.exe, runs npm ci if needed, then release build.

  Output:
    - portable:  src-tauri\target\release\PDF Manager.exe
    - installer: src-tauri\target\release\bundle\nsis\*.exe

  Docs: docs\windows-tauri-build.md

.PARAMETER Upload
  Upload installer to GitHub Release after build (needs gh + auth login).
  Without this flag: local build only (npm run tauri:build:local).

.PARAMETER SkipNpmCi
  Skip npm ci (use when node_modules already exists).

.PARAMETER Dev
  Run npm run tauri:dev instead of release build.

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

function Write-Step([string] $Message) {
  Write-Host ""
  Write-Host ("==> " + $Message) -ForegroundColor Cyan
}

function Write-Ok([string] $Message) {
  Write-Host ("OK  " + $Message) -ForegroundColor Green
}

function Write-Fail([string] $Message) {
  Write-Host ("ERR " + $Message) -ForegroundColor Red
}

function Test-Cmd([string] $Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Assert-Cmd([string] $Name, [string] $Hint) {
  if (-not (Test-Cmd $Name)) {
    Write-Fail ("{0} not found in PATH." -f $Name)
    Write-Host $Hint -ForegroundColor Yellow
    exit 1
  }
  $ver = $null
  try { $ver = & $Name --version 2>$null } catch { }
  if (-not $ver) {
    try { $ver = & $Name -v 2>$null } catch { }
  }
  if ($ver) {
    $first = ($ver | Select-Object -First 1).ToString().Trim()
    Write-Ok ("{0} - {1}" -f $Name, $first)
  } else {
    Write-Ok ("{0} found" -f $Name)
  }
}

# Repo root: script may live in scripts\ or in the repo root.
$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (Test-Path (Join-Path $here 'package.json')) {
  $RepoRoot = Resolve-Path $here
} elseif (Test-Path (Join-Path $here '..\package.json')) {
  $RepoRoot = Resolve-Path (Join-Path $here '..')
} else {
  Write-Fail "Cannot find package.json near the script. Put the script in the repo root or in scripts\."
  exit 1
}

Set-Location $RepoRoot
Write-Host ("Repo: {0}" -f $RepoRoot) -ForegroundColor DarkGray

Write-Step "Environment check"

Assert-Cmd 'node' @"
Install Node.js 20+ LTS: https://nodejs.org/
Then open a NEW PowerShell window.
"@

Assert-Cmd 'npm' @"
npm is installed with Node.js. Open a new terminal after install.
"@

Assert-Cmd 'rustc' @"
Install Rust (stable): https://rustup.rs/
Need Rust 1.85+. New terminal after rustup-init.exe.
"@

Assert-Cmd 'cargo' @"
cargo comes with Rust (rustup). New terminal after install.
"@

$link = Get-Command link.exe -ErrorAction SilentlyContinue
if (-not $link) {
  Write-Fail "link.exe not found (Visual C++ Build Tools)."
  Write-Host @"
Install Build Tools:
  https://visualstudio.microsoft.com/visual-cpp-build-tools/
Workload: Desktop development with C++

Then open a new terminal or "Developer PowerShell for VS 2022"
and run this script again.
"@ -ForegroundColor Yellow
  exit 1
}
Write-Ok ("link.exe - {0}" -f $link.Source)

if ($Upload) {
  Assert-Cmd 'gh' @"
-Upload needs GitHub CLI: https://cli.github.com/
Then: gh auth login
Or build without upload: .\scripts\build-windows-exe.ps1
"@
  $login = $null
  try {
    $login = gh api user --jq .login 2>$null
  } catch {
    $login = $null
  }
  if (-not $login) {
    Write-Fail "gh is not logged in. Run: gh auth login"
    exit 1
  }
  Write-Ok ("gh - logged in as {0}" -f $login)
}

if (-not $SkipNpmCi) {
  Write-Step "npm ci"
  npm ci
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Ok "dependencies installed"
} else {
  Write-Step "npm ci skipped (-SkipNpmCi)"
  if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
    Write-Fail "node_modules missing. Remove -SkipNpmCi or run npm ci."
    exit 1
  }
}

if ($Dev) {
  Write-Step "Dev mode: npm run tauri:dev"
  Write-Host "Window opens after compile. Stop: Ctrl+C" -ForegroundColor DarkGray
  npm run tauri:dev
  exit $LASTEXITCODE
}

if ($Upload) {
  Write-Step "Release build + GitHub upload (npm run tauri:build)"
  Write-Host "First build may take 10-20+ minutes." -ForegroundColor DarkGray
  npm run tauri:build
} else {
  Write-Step "Release build, no upload (npm run tauri:build:local)"
  Write-Host "First build may take 10-20+ minutes." -ForegroundColor DarkGray
  npm run tauri:build:local
}

if ($LASTEXITCODE -ne 0) {
  Write-Fail ("Build failed with exit code {0}" -f $LASTEXITCODE)
  Write-Host "See docs\windows-tauri-build.md section Common errors." -ForegroundColor Yellow
  exit $LASTEXITCODE
}

Write-Step "Done"

$portable = Join-Path $RepoRoot 'src-tauri\target\release\PDF Manager.exe'
$nsisDir = Join-Path $RepoRoot 'src-tauri\target\release\bundle\nsis'

if (Test-Path -LiteralPath $portable) {
  Write-Ok ("Portable: {0}" -f $portable)
} else {
  Write-Fail ("Not found: {0}" -f $portable)
}

if (Test-Path -LiteralPath $nsisDir) {
  $setup = Get-ChildItem -Path $nsisDir -Filter '*.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($setup) {
    Write-Ok ("Installer: {0}" -f $setup.FullName)
  } else {
    Write-Host ("NSIS folder exists but no .exe: {0}" -f $nsisDir) -ForegroundColor Yellow
  }
} else {
  Write-Host ("NSIS folder not created yet: {0}" -f $nsisDir) -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Run portable:" -ForegroundColor DarkGray
Write-Host ('  & "{0}"' -f $portable) -ForegroundColor DarkGray
Write-Host ""
Write-Host "Docs: docs\windows-tauri-build.md" -ForegroundColor DarkGray

#Requires -Version 5.1
<#
.SYNOPSIS
  Build Windows .exe (Tauri) for PDF Manager and upload to GitHub Releases.

.DESCRIPTION
  Checks Node / Rust / MSVC link.exe, runs npm ci if needed, then release build.
  By default ALSO uploads the installer/portable exe to GitHub Release
  windows-v{version} (needs gh + gh auth login).

  If link.exe is not in PATH, loads VS / Build Tools via vswhere + VsDevCmd.bat.

  Output:
    - portable:  src-tauri\target\release\PDF Manager.exe
    - installer: src-tauri\target\release\bundle\nsis\*.exe
    - GitHub:    release tag windows-v{version}

  Docs: docs\windows-tauri-build.md

.PARAMETER Local
  Build only — do NOT upload to GitHub (npm run tauri:build:local).

.PARAMETER SkipNpmCi
  Skip npm ci (use when node_modules already exists).

.PARAMETER Dev
  Run npm run tauri:dev instead of release build.

.EXAMPLE
  .\scripts\build-windows-exe.ps1

.EXAMPLE
  .\scripts\build-windows-exe.ps1 -Local

.EXAMPLE
  .\scripts\build-windows-exe.ps1 -SkipNpmCi
#>

[CmdletBinding()]
param(
  [switch] $Local,
  [switch] $SkipNpmCi,
  [switch] $Dev
)

$ErrorActionPreference = 'Stop'
$doUpload = -not $Local

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

function Get-AppVersion {
  $conf = Join-Path $RepoRoot 'src-tauri\tauri.conf.json'
  if (-not (Test-Path -LiteralPath $conf)) { return $null }
  try {
    $json = Get-Content -LiteralPath $conf -Raw -Encoding UTF8 | ConvertFrom-Json
    return [string]$json.version
  } catch {
    return $null
  }
}

function Get-VsInstallPath {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere)) {
    $alt = Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $alt) { $vswhere = $alt } else { return $null }
  }

  $path = & $vswhere -latest -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath 2>$null
  if ($path) { return ($path | Select-Object -First 1).ToString().Trim() }

  $path = & $vswhere -latest -products * -property installationPath 2>$null
  if ($path) { return ($path | Select-Object -First 1).ToString().Trim() }
  return $null
}

function Import-VsDevEnvironment {
  $installPath = Get-VsInstallPath
  if (-not $installPath) { return $false }

  $vsDevCmd = Join-Path $installPath 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path -LiteralPath $vsDevCmd)) { return $false }

  Write-Host ("Loading MSVC env from: {0}" -f $installPath) -ForegroundColor DarkGray

  $cmdLine = 'call "' + $vsDevCmd + '" -arch=x64 -host_arch=x64 >nul && set'
  $output = & cmd.exe /c $cmdLine 2>$null
  if (-not $output) { return $false }

  foreach ($line in $output) {
    if ($line -match '^([^=]+)=(.*)$') {
      $name = $Matches[1]
      $value = $Matches[2]
      if ($name -match '^[^=]+$') {
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
      }
    }
  }
  return [bool](Get-Command link.exe -ErrorAction SilentlyContinue)
}

function Ensure-LinkExe {
  if (Get-Command link.exe -ErrorAction SilentlyContinue) {
    $link = Get-Command link.exe
    Write-Ok ("link.exe - {0}" -f $link.Source)
    return $true
  }

  Write-Host "link.exe not in PATH - trying Visual Studio / Build Tools..." -ForegroundColor DarkGray
  if (Import-VsDevEnvironment) {
    $link = Get-Command link.exe -ErrorAction SilentlyContinue
    if ($link) {
      Write-Ok ("link.exe - {0}" -f $link.Source)
      return $true
    }
  }

  Write-Fail "link.exe not found (Visual C++ Build Tools / MSVC)."
  Write-Host @"

MSVC linker is required for Tauri/Rust on Windows.

Option A - install Build Tools (recommended):
  1. Download: https://visualstudio.microsoft.com/visual-cpp-build-tools/
  2. Select workload: "Desktop development with C++"
  3. Open a NEW PowerShell and run this script again.

  Or via winget:
    winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

Option B - if Build Tools are already installed:
  Open Start menu -> "Developer PowerShell for VS 2022"
  and run this script from THAT window.

"@ -ForegroundColor Yellow
  return $false
}

function Ensure-GhAuth {
  Assert-Cmd 'gh' @"
GitHub upload needs GitHub CLI: https://cli.github.com/
Then run: gh auth login

Build without upload:
  .\scripts\build-windows-exe.ps1 -Local
"@
  $login = $null
  try {
    $login = gh api user --jq .login 2>$null
  } catch {
    $login = $null
  }
  if (-not $login) {
    Write-Fail "gh is not logged in."
    Write-Host @"
Run in this terminal:
  gh auth login

Then rerun this script. Or build without upload:
  .\scripts\build-windows-exe.ps1 -Local
"@ -ForegroundColor Yellow
    exit 1
  }
  Write-Ok ("gh - logged in as {0}" -f $login)
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

if (-not (Ensure-LinkExe)) { exit 1 }

if ($doUpload) {
  Ensure-GhAuth
  $ver = Get-AppVersion
  if ($ver) {
    Write-Host ("Will upload to GitHub Release tag: windows-v{0}" -f $ver) -ForegroundColor DarkGray
  }
} else {
  Write-Host "Local build only (-Local): GitHub upload skipped." -ForegroundColor DarkGray
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

if ($doUpload) {
  Write-Step "Release build + GitHub upload (npm run tauri:build)"
  Write-Host "First build may take 10-20+ minutes. Then gh uploads the .exe." -ForegroundColor DarkGray
  # Ensure upload script is not skipped by a leftover env var
  Remove-Item Env:TAURI_SKIP_UPLOAD -ErrorAction SilentlyContinue
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

if ($doUpload) {
  $ver = Get-AppVersion
  if ($ver) {
    $tag = "windows-v$ver"
    Write-Host ""
    Write-Ok ("GitHub Release tag: {0}" -f $tag)
    try {
      $url = gh release view $tag --json url --jq .url 2>$null
      if ($url) { Write-Ok ("Release URL: {0}" -f $url) }
    } catch { }
  }
}

Write-Host ""
Write-Host "Run portable:" -ForegroundColor DarkGray
Write-Host ('  & "{0}"' -f $portable) -ForegroundColor DarkGray
Write-Host ""
Write-Host "Docs: docs\windows-tauri-build.md" -ForegroundColor DarkGray

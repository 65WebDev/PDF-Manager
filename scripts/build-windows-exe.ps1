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

.PARAMETER SkipGitSync
  Do not fetch/checkout latest origin/main before building.

.PARAMETER Force
  Discard local changes and hard-reset to origin/main (for one-click build shortcuts).

.PARAMETER NoBump
  Do not auto-bump Windows semver when main has commits since the last windows-v* release.

.EXAMPLE
  .\scripts\build-windows-exe.ps1

.EXAMPLE
  .\scripts\build-windows-exe.ps1 -Local

.EXAMPLE
  .\scripts\build-windows-exe.ps1 -SkipNpmCi

.EXAMPLE
  .\scripts\build-windows-exe.ps1 -SkipGitSync

.EXAMPLE
  .\scripts\build-windows-exe.ps1 -Force -Local
#>

[CmdletBinding()]
param(
  [switch] $Local,
  [switch] $SkipNpmCi,
  [switch] $Dev,
  [switch] $SkipGitSync,
  [switch] $Force,
  [switch] $NoBump
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

function Ensure-LatestMain {
  Assert-Cmd 'git' @"
Git is required to sync the latest main before build.
Install: https://git-scm.com/download/win
Or skip sync: .\scripts\build-windows-exe.ps1 -SkipGitSync
"@

  if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) {
    Write-Fail "Not a git repository: $RepoRoot"
    Write-Host "Clone the repo (not a ZIP download), or use -SkipGitSync." -ForegroundColor Yellow
    exit 1
  }

  if ($SkipGitSync -and $Force) {
    Write-Fail "Use either -Force or -SkipGitSync, not both."
    exit 1
  }

  $status = & git -C $RepoRoot status --porcelain 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "git status failed."
    exit 1
  }
  if ($status -and -not $Force) {
    Write-Fail "Working tree has local changes — refusing to switch to main."
    Write-Host @"
For a build folder / desktop shortcut (discard local edits, use latest main):
  .\scripts\build-windows-exe.ps1 -Force

Or keep your local tree and build it as-is:
  .\scripts\build-windows-exe.ps1 -SkipGitSync

Or manually discard, then rerun without -Force:
  git checkout main
  git fetch origin main
  git reset --hard origin/main
"@ -ForegroundColor Yellow
    Write-Host $status -ForegroundColor DarkGray
    exit 1
  }

  Write-Step "Sync latest origin/main"
  & git -C $RepoRoot fetch origin main
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "git fetch origin main failed."
    exit $LASTEXITCODE
  }

  if ($Force) {
    if ($status) {
      Write-Host "Discarding local changes (-Force)..." -ForegroundColor Yellow
      Write-Host $status -ForegroundColor DarkGray
    }
    # Must wipe the index/worktree BEFORE checkout - plain checkout -B still
    # refuses to overwrite dirty tracked files (Windows build clones often have
    # leftover version.json / README edits from a previous upload).
    & git -C $RepoRoot reset --hard HEAD
    if ($LASTEXITCODE -ne 0) {
      Write-Fail "git reset --hard HEAD failed."
      exit $LASTEXITCODE
    }
    & git -C $RepoRoot clean -fd
    if ($LASTEXITCODE -ne 0) {
      Write-Fail "git clean -fd failed."
      exit $LASTEXITCODE
    }
    & git -C $RepoRoot checkout -f -B main origin/main
    if ($LASTEXITCODE -ne 0) {
      Write-Fail "git checkout -f -B main origin/main failed."
      exit $LASTEXITCODE
    }
    & git -C $RepoRoot reset --hard origin/main
    if ($LASTEXITCODE -ne 0) {
      Write-Fail "git reset --hard origin/main failed."
      exit $LASTEXITCODE
    }
  } else {
    $branch = (& git -C $RepoRoot rev-parse --abbrev-ref HEAD 2>$null)
    if ($branch -ne 'main') {
      Write-Host ("Current branch: {0} -> checking out main" -f $branch) -ForegroundColor DarkGray
      & git -C $RepoRoot checkout main
      if ($LASTEXITCODE -ne 0) {
        Write-Fail "git checkout main failed."
        exit $LASTEXITCODE
      }
    }

    & git -C $RepoRoot pull --ff-only origin main
    if ($LASTEXITCODE -ne 0) {
      Write-Fail "git pull --ff-only origin main failed (local main may have diverged)."
      Write-Host @"
Reset hard to remote main (discards local commits/edits on this clone):
  .\scripts\build-windows-exe.ps1 -Force

Or build without syncing:
  .\scripts\build-windows-exe.ps1 -SkipGitSync
"@ -ForegroundColor Yellow
      exit $LASTEXITCODE
    }
  }

  $head = (& git -C $RepoRoot rev-parse --short HEAD 2>$null)
  $subj = (& git -C $RepoRoot log -1 --pretty=%s 2>$null)
  Write-Ok ("main @ {0} — {1}" -f $head, $subj)
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

if (-not $SkipGitSync) {
  Ensure-LatestMain
} else {
  Write-Step "Git sync skipped (-SkipGitSync)"
  if (Test-Cmd 'git') {
    $branch = (& git -C $RepoRoot rev-parse --abbrev-ref HEAD 2>$null)
    $head = (& git -C $RepoRoot rev-parse --short HEAD 2>$null)
    if ($branch -and $head) {
      Write-Host ("Building from {0} @ {1}" -f $branch, $head) -ForegroundColor DarkGray
    }
  }
}

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

# Show which versions will appear in About (Windows package + editor build-N).
$appVerPreview = Get-AppVersion
if ($appVerPreview) {
  Write-Host ("About primary version (Windows package): {0}" -f $appVerPreview) -ForegroundColor DarkGray
} else {
  Write-Host "WARN could not read Windows version from tauri.conf.json" -ForegroundColor Yellow
}
$verJsonPath = Join-Path $RepoRoot 'version.json'
if (Test-Path -LiteralPath $verJsonPath) {
  try {
    $verInfo = Get-Content -LiteralPath $verJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($verInfo.build) {
      Write-Host ("About secondary (editor build): {0} (from version.json on current HEAD)" -f $verInfo.build) -ForegroundColor DarkGray
    }
  } catch {
    Write-Host "Could not read version.json for build stamp preview." -ForegroundColor DarkGray
  }
} else {
  Write-Host "WARN version.json missing — About may show an unknown/old editor build." -ForegroundColor Yellow
}

if ($Dev) {
  Write-Step "Dev mode: npm run tauri:dev"
  Write-Host "Window opens after compile. Stop: Ctrl+C" -ForegroundColor DarkGray
  npm run tauri:dev
  exit $LASTEXITCODE
}

if ($doUpload -and -not $NoBump) {
  # Shrink the race window: version-feed commits often land on main while npm ci runs.
  if (-not $SkipGitSync) {
    Write-Step "Refresh origin/main before Windows version bump"
    & git -C $RepoRoot fetch origin main
    if ($LASTEXITCODE -ne 0) {
      Write-Fail "git fetch origin main failed (before version bump)."
      exit $LASTEXITCODE
    }
    & git -C $RepoRoot pull --ff-only origin main
    if ($LASTEXITCODE -ne 0) {
      Write-Fail "git pull --ff-only origin main failed (before version bump)."
      Write-Host "If you have a leftover local bump commit from a failed build, use -Force or:" -ForegroundColor Yellow
      Write-Host "  git pull --rebase origin main" -ForegroundColor Yellow
      Write-Host "  git push origin HEAD" -ForegroundColor Yellow
      exit $LASTEXITCODE
    }
    $head = (& git -C $RepoRoot rev-parse --short HEAD 2>$null)
    Write-Ok ("main @ {0} (pre-bump)" -f $head)
  }

  Write-Step "Auto-bump Windows version if tool changed since last windows-v* release"
  node (Join-Path $RepoRoot 'scripts\bump-windows-version-if-needed.mjs')
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "Windows version bump check failed."
    exit $LASTEXITCODE
  }
  $ver = Get-AppVersion
  if ($ver) {
    Write-Host ("Release tag for this build: windows-v{0}" -f $ver) -ForegroundColor DarkGray
    Write-Host ("About will show primary version: {0}" -f $ver) -ForegroundColor DarkGray
  }
} elseif ($doUpload -and $NoBump) {
  Write-Step "Windows version auto-bump skipped (-NoBump)"
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

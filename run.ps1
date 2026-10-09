param([string]$Command = "start", [string]$Path = "")
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
$LocalNode = Join-Path $Root '.runtime\node.exe'
$LocalNpmCli = Join-Path $Root '.runtime\node_modules\npm\bin\npm-cli.js'
if ((Test-Path -LiteralPath $LocalNode -PathType Leaf) -and (Test-Path -LiteralPath $LocalNpmCli -PathType Leaf)) {
  $NodeCommand = $LocalNode
  $NpmCli = $LocalNpmCli
  $env:Path = "$(Join-Path $Root '.runtime')$([IO.Path]::PathSeparator)$env:Path"
} else {
  $NodeCommand = 'node'
  $NpmCli = $null
}

function Get-Sha256([string]$FilePath) {
  # .NET resolves relative paths against the host process working directory,
  # which may remain C:\Windows\System32 after Set-Location changes PowerShell's
  # location. Resolve through PowerShell first so source installs are portable.
  $ResolvedPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($FilePath)
  $Stream = [IO.File]::OpenRead($ResolvedPath)
  try {
    $Algorithm = [Security.Cryptography.SHA256]::Create()
    try {
      $Hash = $Algorithm.ComputeHash($Stream)
      return [BitConverter]::ToString($Hash).Replace('-', '').ToLowerInvariant()
    }
    finally {
      $Algorithm.Dispose()
    }
  }
  finally {
    $Stream.Dispose()
  }
}

function Invoke-Npm {
  if ($null -ne $NpmCli) { & $NodeCommand $NpmCli @args }
  else { & npm @args }
  if ($LASTEXITCODE -ne 0) { throw "npm command failed with exit code $LASTEXITCODE" }
}

function Invoke-Launcher([string]$LauncherCommand) {
  & $NodeCommand scripts/launcher.mjs $LauncherCommand
  if ($LASTEXITCODE -ne 0) { throw "Gate CrossEx $LauncherCommand failed with exit code $LASTEXITCODE" }
}

function Ensure-Node {
  if (-not (Get-Command $NodeCommand -ErrorAction SilentlyContinue)) {
    throw "Node.js 20.19+, 22.13+, or 24 is required. Install an LTS release from https://nodejs.org/"
  }
  $versionParts = (& $NodeCommand -p "process.versions.node").Trim().Split('.')
  $major = [int]$versionParts[0]
  $minor = [int]$versionParts[1]
  if (($major -eq 20 -and $minor -lt 19) -or $major -eq 21 -or ($major -eq 22 -and $minor -lt 13) -or $major -lt 20 -or $major -eq 23 -or $major -ge 25) {
    throw "Node.js 20.19+, 22.13+, or 24 required; found $(& $NodeCommand -v)"
  }
}

function Test-WorkspaceLinks {
  $Manifest = Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
  $WorkspaceValue = $Manifest.workspaces
  if ($null -eq $WorkspaceValue) { return $true }
  $PackagesProperty = $WorkspaceValue.PSObject.Properties['packages']
  $Patterns = if ($null -ne $PackagesProperty) { @($PackagesProperty.Value) } else { @($WorkspaceValue) }
  foreach ($Pattern in $Patterns) {
    $NormalizedPattern = ([string]$Pattern).Replace('/', '\')
    $ManifestPattern = Join-Path $Root (Join-Path $NormalizedPattern 'package.json')
    foreach ($WorkspaceManifestPath in @(Get-ChildItem -Path $ManifestPattern -File -ErrorAction SilentlyContinue)) {
      $WorkspaceManifest = Get-Content -LiteralPath $WorkspaceManifestPath.FullName -Raw | ConvertFrom-Json
      $WorkspaceName = [string]$WorkspaceManifest.name
      if ([string]::IsNullOrWhiteSpace($WorkspaceName)) { continue }
      $InstalledManifest = Join-Path $Root (Join-Path 'node_modules' (Join-Path $WorkspaceName.Replace('/', '\') 'package.json'))
      if (-not (Test-Path -LiteralPath $InstalledManifest -PathType Leaf)) { return $false }
      $InstalledName = [string](Get-Content -LiteralPath $InstalledManifest -Raw | ConvertFrom-Json).name
      if ($InstalledName -ne $WorkspaceName) { return $false }
    }
  }
  return $true
}

function Ensure-Dependencies {
  New-Item -ItemType Directory -Force .local-data, logs | Out-Null
  $Expected = Get-Sha256 'package-lock.json'
  $DependencyMarker = '.local-data/dependencies.sha256'
  $Installed = if (Test-Path -LiteralPath $DependencyMarker -PathType Leaf) {
    (Get-Content -LiteralPath $DependencyMarker -Raw).Trim().ToLowerInvariant()
  } else { '' }
  if (-not (Test-Path node_modules/.bin/tsx.cmd) -or $Installed -ne $Expected -or -not (Test-WorkspaceLinks)) {
    Write-Host "Installing pinned dependencies..."
    Invoke-Npm ci --cache .local-data/npm-cache --no-audit --no-fund
    if (-not (Test-WorkspaceLinks)) { throw 'npm ci did not create usable workspace links.' }
    Set-Content -LiteralPath $DependencyMarker -Value $Expected -Encoding ASCII
  }
}

function Test-UpdateBranch {
  if (-not (Test-Path -LiteralPath '.git')) { return $true }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $false }
  $Branch = ([string](& git branch --show-current 2>$null)).Trim()
  return $Branch -in 'main', 'master'
}

function Offer-Update {
  if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { return }
  if ($env:GCT_SKIP_UPDATE_CHECK -eq '1' -or -not (Test-UpdateBranch)) { return }

  $UpdateInfo = (& $NodeCommand scripts/check-for-update.mjs 2>$null | Select-Object -First 1)
  if ([string]::IsNullOrWhiteSpace($UpdateInfo)) { return }
  $Versions = $UpdateInfo -split "`t", 2
  if ($Versions.Count -ne 2) { return }

  Write-Host "Gate CrossEx $($Versions[1]) is available (installed: v$($Versions[0]))."
  Write-Host "Gate CrossEx $($Versions[1]) 有新版本可用（当前版本：v$($Versions[0])）。"
  $Answer = Read-Host 'Update now? / 是否立即更新？ [y/N]'
  if ($Answer -notmatch '^(y|yes)$') {
    Write-Host 'Continuing without updating.'
    return
  }

  Write-Host 'Starting the update. Run .\run.ps1 again when it finishes.'
  & (Join-Path $Root 'run.ps1') update
  if ($LASTEXITCODE -ne 0) { throw "Gate CrossEx update failed with exit code $LASTEXITCODE" }
  exit 0
}

Ensure-Node
switch ($Command) {
  "start" {
    Offer-Update
    Ensure-Dependencies
    Invoke-Launcher $Command
    break
  }
  "dev" {
    Ensure-Dependencies
    Invoke-Launcher $Command
    break
  }
  { $_ -in "doctor", "stop", "logs" } {
    Invoke-Launcher $Command
    break
  }
  "reset" {
    $answer = Read-Host "Destructive reset removes local configuration and database. Type RESET to continue"
    if ($answer -eq "RESET") {
      Invoke-Launcher 'stop'
      Remove-Item -Recurse -Force .local-data
      Write-Host "Local state reset."
    } else { Write-Host "Reset aborted." }
    break
  }
  "update" {
    if ((Test-Path -LiteralPath '.gate-crossex-source-install' -PathType Leaf) -and -not (Test-Path -LiteralPath '.git' -PathType Container)) {
      & (Join-Path $Root 'bootstrap.ps1') -Update
      break
    }
    Invoke-Launcher 'stop'
    Ensure-Dependencies
    if (Test-Path .local-data/gate-crossex.sqlite) {
      $stamp = Get-Date -Format "yyyyMMddHHmmss"
      $backupPath = ".local-data/gate-crossex.sqlite.backup.$stamp"
      & $NodeCommand scripts/backup-database.mjs .local-data/gate-crossex.sqlite $backupPath
      Write-Host "Consistent database backup created at $backupPath."
    }
    git pull --ff-only
    Invoke-Npm ci --cache .local-data/npm-cache --no-audit --no-fund
    $LockHash = Get-Sha256 'package-lock.json'
    Set-Content -LiteralPath '.local-data/dependencies.sha256' -Value $LockHash -Encoding ASCII
    Invoke-Npm run build
    break
  }
  "backup" {
    Ensure-Dependencies
    Invoke-Launcher 'stop'
    if (-not (Test-Path .local-data/gate-crossex.sqlite)) { throw "No local database exists to back up." }
    if (-not $Path) {
      $stamp = Get-Date -Format "yyyyMMddHHmmss"
      $Path = ".local-data/gate-crossex.sqlite.backup.$stamp"
    }
    & $NodeCommand scripts/backup-database.mjs .local-data/gate-crossex.sqlite $Path
    Write-Host "Verified database backup created at $Path."
    break
  }
  "restore" {
    Ensure-Dependencies
    if (-not $Path) { throw "Usage: ./run.ps1 restore <backup.sqlite>" }
    $answer = Read-Host "Restore from $Path; the current database will be preserved. Type RESTORE to continue"
    if ($answer -ne "RESTORE") { Write-Host "Restore aborted."; break }
    Invoke-Launcher 'stop'
    & $NodeCommand scripts/restore-database.mjs $Path .local-data/gate-crossex.sqlite
    break
  }
  "maintenance" {
    Ensure-Dependencies
    Invoke-Launcher 'stop'
    & $NodeCommand scripts/maintain-database.mjs .local-data/gate-crossex.sqlite
    break
  }
  default { throw "Usage: ./run.ps1 [dev|doctor|stop|logs|reset|update|backup|restore|maintenance] [path]" }
}

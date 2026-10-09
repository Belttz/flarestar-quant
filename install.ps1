# Gate CrossEx Windows bootstrap installer.
#
# Downloads a target-native, checksum-verified release bundle containing Node.js,
# the production application, native dependencies, and database migrations. It
# installs only for the current user and does not modify PATH or request elevation.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Script:TempDirectory = $null
$Script:StageDirectory = $null

function Get-Setting([string]$Name, [string]$Default) {
    $Value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $Default }
    return $Value
}

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-Sha256([string]$Path) {
    $Stream = [IO.File]::OpenRead($Path)
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

function Get-WindowsArchitecture {
    try {
        $Architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }
    catch {
        $Architecture = $env:PROCESSOR_ARCHITEW6432
        if ([string]::IsNullOrWhiteSpace($Architecture)) { $Architecture = $env:PROCESSOR_ARCHITECTURE }
    }
    switch ($Architecture.ToUpperInvariant()) {
        'X64' { return 'x64' }
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        default { throw "Unsupported Windows architecture: $Architecture" }
    }
}

function Assert-SafeRoot([string]$Path, [string]$MarkerPath) {
    $FullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $DriveRoot = [IO.Path]::GetPathRoot($FullPath).TrimEnd('\')
    $Forbidden = @($DriveRoot, $env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') }
    if ($Forbidden -contains $FullPath) { throw "Unsafe installation root: $FullPath" }
    if (Test-Path -LiteralPath $FullPath -PathType Leaf) {
        throw "The installation root exists but is not a directory: $FullPath"
    }
    if ((Test-Path -LiteralPath $FullPath -PathType Container) -and
        -not (Test-Path -LiteralPath $MarkerPath -PathType Leaf) -and
        $null -ne (Get-ChildItem -LiteralPath $FullPath -Force | Select-Object -First 1)) {
        throw "The installation root is non-empty and is not recognized as a Gate CrossEx installation: $FullPath"
    }
    if ((Test-Path -LiteralPath $MarkerPath -PathType Leaf) -and
        (Get-Content -LiteralPath $MarkerPath -Raw).Trim() -ne 'Gate CrossEx install root v1') {
        throw "The installation-root marker is invalid: $MarkerPath"
    }
}

function Invoke-Download([string]$Uri, [string]$Destination) {
    $Previous = [Net.ServicePointManager]::SecurityProtocol
    try {
        [Net.ServicePointManager]::SecurityProtocol = $Previous -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing
    }
    finally {
        [Net.ServicePointManager]::SecurityProtocol = $Previous
    }
}

function Assert-SafeZip([string]$ArchivePath) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $FoundManifest = $false
        foreach ($Entry in $Archive.Entries) {
            $Name = $Entry.FullName.Replace('\', '/')
            $Parts = $Name.Split('/')
            if ([string]::IsNullOrWhiteSpace($Name) -or $Name.StartsWith('/') -or
                $Name.Contains(':') -or $Parts -contains '..' -or
                -not $Name.StartsWith('gate-crossex/', [StringComparison]::Ordinal)) {
                throw "Release archive contains an unsafe path: $Name"
            }
            if ($Name -eq 'gate-crossex/release.json') { $FoundManifest = $true }
        }
        if (-not $FoundManifest) { throw 'Release archive is missing gate-crossex/release.json.' }
    }
    finally {
        $Archive.Dispose()
    }
}

function Expand-ReleaseZip([string]$ArchivePath, [string]$Destination) {
    # Windows PowerShell's Expand-Archive can fail on the deep node_modules tree.
    # The built-in bsdtar supports those paths and receives an already-validated ZIP.
    $Tar = (Get-Command tar.exe -ErrorAction Stop).Source
    & $Tar -xf $ArchivePath -C $Destination
    if ($LASTEXITCODE -ne 0) { throw 'Release archive extraction failed.' }
}

function Get-OwnedBackendProcessId([string]$InstallRoot) {
    $LockPath = Join-Path $InstallRoot 'data\backend.lock'
    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) { return $null }
    try {
        $Lock = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
        $ProcessId = [int]$Lock.pid
        $Process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
        if ($null -eq $Process) { return $null }
        $Versions = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'versions'))
        if ([string]$Process.CommandLine -and
            ([string]$Process.CommandLine).IndexOf($Versions, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $ProcessId
        }
    }
    catch {
        return $null
    }
    return $null
}

function Stop-InstalledService([string]$InstallRoot, [string]$InstalledTaskName, [bool]$Skip) {
    if ($Skip) { return }
    if ($null -ne (Get-ScheduledTask -TaskName $InstalledTaskName -ErrorAction SilentlyContinue)) {
        Write-Step 'Stopping the installed backend safely...'
        Stop-ScheduledTask -TaskName $InstalledTaskName -ErrorAction SilentlyContinue
    }
    for ($Attempt = 0; $Attempt -lt 140; $Attempt++) {
        if ($null -eq (Get-OwnedBackendProcessId $InstallRoot)) { return }
        Start-Sleep -Milliseconds 250
    }
    throw 'The existing backend did not finish its safety shutdown; no application files were switched.'
}

function Backup-Database([string]$InstallRoot, [string]$RuntimeDirectory, [string]$NewReleaseDirectory, [string]$NewReleaseId) {
    $Database = Join-Path $InstallRoot 'data\gate-crossex.sqlite'
    if (-not (Test-Path -LiteralPath $Database -PathType Leaf)) { return }
    if ([string]::IsNullOrWhiteSpace($RuntimeDirectory) -or
        -not (Test-Path -LiteralPath (Join-Path $RuntimeDirectory 'runtime\node.exe') -PathType Leaf)) {
        $RuntimeDirectory = $NewReleaseDirectory
    }
    $Node = Join-Path $RuntimeDirectory 'runtime\node.exe'
    $BackupScript = Join-Path $RuntimeDirectory 'app\scripts\backup-database.mjs'
    $Timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
    $Destination = Join-Path $InstallRoot "backups\gate-crossex-before-$NewReleaseId-$Timestamp-$PID.sqlite"
    Write-Step 'Creating a verified database backup...'
    & $Node $BackupScript $Database $Destination
    if ($LASTEXITCODE -ne 0) { throw 'The pre-update database backup failed; the installed release was not switched.' }
}

function Test-PortAvailable([int]$Port) {
    $Listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return $null -eq ($Listeners | Where-Object { $_.Port -eq $Port } | Select-Object -First 1)
}

function Write-InstallConfig([string]$InstallRoot, [int]$Port, [string]$InstalledTaskName, [string]$InstalledShortcut) {
    $ConfigPath = Join-Path $InstallRoot 'config\install.json'
    $TemporaryPath = "$ConfigPath.tmp-$PID"
    @{
        schema = 1
        port = $Port
        taskName = $InstalledTaskName
        shortcutPath = $InstalledShortcut
    } | ConvertTo-Json | Set-Content -LiteralPath $TemporaryPath -Encoding UTF8
    Move-Item -LiteralPath $TemporaryPath -Destination $ConfigPath -Force
}

function Set-CurrentRelease([string]$InstallRoot, [string]$ReleaseDirectory) {
    $CurrentPath = Join-Path $InstallRoot 'current-release.txt'
    $TemporaryPath = "$CurrentPath.tmp-$PID"
    Set-Content -LiteralPath $TemporaryPath -Value $ReleaseDirectory -Encoding UTF8
    Move-Item -LiteralPath $TemporaryPath -Destination $CurrentPath -Force
}

function Register-GctTask([string]$InstallRoot, [string]$InstalledTaskName) {
    $PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $ServiceScript = Join-Path $InstallRoot 'bin\service.ps1'
    $Action = New-ScheduledTaskAction -Execute $PowerShell `
        -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ServiceScript`"" `
        -WorkingDirectory $InstallRoot
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $Identity
    $Principal = New-ScheduledTaskPrincipal -UserId $Identity -LogonType Interactive -RunLevel Limited
    $Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $InstalledTaskName -Action $Action -Trigger $Trigger `
        -Principal $Principal -Settings $Settings -Force | Out-Null
}

function Write-Shortcut([string]$InstallRoot, [string]$InstalledShortcut) {
    if ($InstalledShortcut -notlike '*.lnk') { throw "Unsafe shortcut path: $InstalledShortcut" }
    $Parent = Split-Path -Parent $InstalledShortcut
    New-Item -ItemType Directory -Path $Parent -Force | Out-Null
    $PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $Cli = Join-Path $InstallRoot 'bin\gate-crossex.ps1'
    $Shell = New-Object -ComObject WScript.Shell
    $Shortcut = $Shell.CreateShortcut($InstalledShortcut)
    $Shortcut.TargetPath = $PowerShell
    $Shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Cli`" open"
    $Shortcut.WorkingDirectory = $InstallRoot
    $Shortcut.Description = 'Open Gate CrossEx Local Trading Terminal'
    $Shortcut.Save()
}

function Test-GctHealthy([int]$Port) {
    try {
        $Discovery = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/system/discovery" -TimeoutSec 2
        return $Discovery.product -eq 'Gate CrossEx Local Trading Terminal'
    }
    catch {
        return $false
    }
}

function Start-AndWait([string]$InstalledTaskName, [int]$Port) {
    Start-ScheduledTask -TaskName $InstalledTaskName
    for ($Attempt = 0; $Attempt -lt 120; $Attempt++) {
        if (Test-GctHealthy $Port) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Install-GateCrossEx {
    if ($env:OS -ne 'Windows_NT') { throw 'This installer currently supports Windows only.' }

    $RepoSlug = Get-Setting 'GCT_REPO_SLUG' 'Belttz/flarestar-quant'
    $ReleaseTag = Get-Setting 'GCT_RELEASE_TAG' 'latest'
    $Root = [IO.Path]::GetFullPath((Get-Setting 'GCT_INSTALL_ROOT' (Join-Path $env:LOCALAPPDATA 'Gate CrossEx'))).TrimEnd('\')
    $Marker = Join-Path $Root '.gate-crossex-install-root'
    $SkipService = (Get-Setting 'GCT_SKIP_SERVICE' '0') -eq '1'
    $OpenBrowser = Get-Setting 'GCT_OPEN_BROWSER' '1'
    if ($OpenBrowser -notin @('0', '1')) { throw 'GCT_OPEN_BROWSER must be 0 or 1.' }
    if ($RepoSlug -notmatch '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$' -or $RepoSlug -match '(^|/)\.\.?($|/)') {
        throw "Invalid GCT_REPO_SLUG: $RepoSlug"
    }
    if ($ReleaseTag -notmatch '^[A-Za-z0-9._-]+$') { throw "Invalid GCT_RELEASE_TAG: $ReleaseTag" }

    Assert-SafeRoot $Root $Marker
    foreach ($Directory in @('versions', 'data', 'config', 'logs', 'backups', 'bin')) {
        New-Item -ItemType Directory -Path (Join-Path $Root $Directory) -Force | Out-Null
    }
    Set-Content -LiteralPath $Marker -Value 'Gate CrossEx install root v1' -Encoding ASCII

    $ExistingConfigPath = Join-Path $Root 'config\install.json'
    $ExistingConfig = $null
    if (Test-Path -LiteralPath $ExistingConfigPath -PathType Leaf) {
        $ExistingConfig = Get-Content -LiteralPath $ExistingConfigPath -Raw | ConvertFrom-Json
    }
    if ($null -ne $ExistingConfig) {
        $Port = [int]$ExistingConfig.port
        $TaskName = [string]$ExistingConfig.taskName
        $ShortcutPath = [string]$ExistingConfig.shortcutPath
    }
    else {
        $PortText = Get-Setting 'GCT_PORT' '17840'
        $ParsedPort = 0
        if (-not [int]::TryParse($PortText, [ref]$ParsedPort) -or $ParsedPort -lt 1 -or $ParsedPort -gt 65535) {
            throw 'GCT_PORT must be an integer between 1 and 65535.'
        }
        $Port = $ParsedPort
        $TaskName = Get-Setting 'GCT_TASK_NAME' 'Gate CrossEx'
        $ShortcutPath = Get-Setting 'GCT_SHORTCUT_PATH' (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Gate CrossEx.lnk')
    }
    if ($TaskName -notmatch '^[A-Za-z0-9 ._-]{1,100}$') { throw 'Invalid scheduled task name.' }
    if ($ShortcutPath -notlike '*.lnk') { throw "Unsafe shortcut path: $ShortcutPath" }
    $ShortcutOverride = [Environment]::GetEnvironmentVariable('GCT_SHORTCUT_PATH')
    if ([string]::IsNullOrWhiteSpace($ShortcutOverride)) {
        $StartMenuRoot = [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')).TrimEnd('\') + '\'
        $FullShortcut = [IO.Path]::GetFullPath($ShortcutPath)
        if (-not $FullShortcut.StartsWith($StartMenuRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The configured shortcut is outside the current user Start Menu.'
        }
    }

    $Script:TempDirectory = Join-Path ([IO.Path]::GetTempPath()) ("gate-crossex-install-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $Script:TempDirectory | Out-Null
    $Architecture = Get-WindowsArchitecture
    $Asset = "gate-crossex-win32-$Architecture.zip"
    $ArchivePath = Join-Path $Script:TempDirectory $Asset

    Write-Host ''
    Write-Step 'Installing Gate CrossEx without modifying system Node.js'
    $LocalArchive = [Environment]::GetEnvironmentVariable('GCT_ARCHIVE')
    if (-not [string]::IsNullOrWhiteSpace($LocalArchive)) {
        if (-not (Test-Path -LiteralPath $LocalArchive -PathType Leaf)) { throw "GCT_ARCHIVE does not exist: $LocalArchive" }
        Copy-Item -LiteralPath $LocalArchive -Destination $ArchivePath
        $ExpectedHash = [Environment]::GetEnvironmentVariable('GCT_SHA256')
        if ([string]::IsNullOrWhiteSpace($ExpectedHash)) { throw 'GCT_SHA256 is required with GCT_ARCHIVE.' }
    }
    else {
        if ($ReleaseTag -eq 'latest') {
            $BaseUrl = "https://github.com/$RepoSlug/releases/latest/download"
        }
        else {
            $BaseUrl = "https://github.com/$RepoSlug/releases/download/$ReleaseTag"
        }
        Write-Step "Downloading the $Architecture release bundle..."
        Invoke-Download "$BaseUrl/$Asset" $ArchivePath
        $ChecksumPath = Join-Path $Script:TempDirectory 'SHA256SUMS'
        Invoke-Download "$BaseUrl/SHA256SUMS" $ChecksumPath
        $Pattern = '^([0-9A-Fa-f]{64})\s+\*?' + [Regex]::Escape($Asset) + '$'
        $ChecksumLine = Get-Content -LiteralPath $ChecksumPath | Where-Object { $_ -match $Pattern } | Select-Object -First 1
        if ($null -eq $ChecksumLine) { throw "SHA256SUMS does not contain $Asset." }
        [void]($ChecksumLine -match $Pattern)
        $ExpectedHash = $Matches[1]
    }
    if ($ExpectedHash -notmatch '^[0-9A-Fa-f]{64}$') { throw "Invalid SHA-256 for $Asset." }
    $ActualHash = Get-Sha256 $ArchivePath
    if ($ActualHash -ne $ExpectedHash.ToLowerInvariant()) { throw "Release checksum verification failed for $Asset." }
    Write-Step 'Release checksum verified.'

    Assert-SafeZip $ArchivePath
    $Script:StageDirectory = Join-Path $Root "versions\.staging-$PID-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $Script:StageDirectory | Out-Null
    Expand-ReleaseZip $ArchivePath $Script:StageDirectory
    $Bundle = Join-Path $Script:StageDirectory 'gate-crossex'
    Get-ChildItem -LiteralPath $Bundle -Recurse -File | Unblock-File
    $ManifestPath = Join-Path $Bundle 'release.json'
    $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($Manifest.product -ne 'Gate CrossEx Local Trading Terminal') { throw 'Release product identity is invalid.' }
    if ($Manifest.platform -ne 'win32') { throw "Release platform is $($Manifest.platform), expected win32." }
    if ($Manifest.arch -ne $Architecture) { throw "Release architecture is $($Manifest.arch), expected $Architecture." }
    if ([string]$Manifest.version -notmatch '^[0-9A-Za-z.+-]+$') { throw "Invalid release version: $($Manifest.version)" }
    if ([string]$Manifest.commit -notmatch '^[0-9A-Fa-f]{40}$') { throw 'Release commit must be a full Git SHA.' }
    foreach ($Required in @(
        'runtime\node.exe',
        'app\apps\backend\dist\server.js',
        'app\apps\frontend\dist\index.html',
        'app\migrations',
        'app\uninstall.ps1',
        'app\packaging\windows\service.ps1',
        'app\packaging\windows\gate-crossex.ps1'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $Bundle $Required))) { throw "Release is missing $Required" }
    }
    $BundledNode = Join-Path $Bundle 'runtime\node.exe'
    & $BundledNode --version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The bundled Node runtime cannot run on this computer.' }
    Push-Location (Join-Path $Bundle 'app')
    try {
        & $BundledNode -e "require('better-sqlite3'); require('@napi-rs/keyring')"
        if ($LASTEXITCODE -ne 0) { throw 'The bundled native dependencies cannot run on this computer.' }
    }
    finally {
        Pop-Location
    }

    $ReleaseId = "$($Manifest.version)-$(([string]$Manifest.commit).Substring(0, 12).ToLowerInvariant())"
    $ReleaseDirectory = Join-Path $Root "versions\$ReleaseId"
    if (Test-Path -LiteralPath $ReleaseDirectory -PathType Container) {
        $StoredHashPath = Join-Path $ReleaseDirectory '.archive-sha256'
        $StoredHash = if (Test-Path -LiteralPath $StoredHashPath -PathType Leaf) {
            (Get-Content -LiteralPath $StoredHashPath -Raw).Trim()
        } else { '' }
        if ($StoredHash -ne $ActualHash -or
            -not (Test-Path -LiteralPath (Join-Path $ReleaseDirectory 'runtime\node.exe') -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $ReleaseDirectory 'app\apps\backend\dist\server.js') -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $ReleaseDirectory 'app\apps\frontend\dist\index.html') -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $ReleaseDirectory 'app\uninstall.ps1') -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $ReleaseDirectory 'app\packaging\windows\service.ps1') -PathType Leaf)) {
            throw "The existing $ReleaseId directory does not match this verified archive; move it aside and retry."
        }
        Write-Step "Release $ReleaseId is already verified and staged; reusing it."
    }
    else {
        Set-Content -LiteralPath (Join-Path $Bundle '.archive-sha256') -Value $ActualHash -Encoding ASCII
        Move-Item -LiteralPath $Bundle -Destination $ReleaseDirectory
    }
    Remove-Item -LiteralPath $Script:StageDirectory -Recurse -Force
    $Script:StageDirectory = $null

    Copy-Item -LiteralPath (Join-Path $ReleaseDirectory 'app\uninstall.ps1') -Destination (Join-Path $Root 'uninstall.ps1') -Force
    Copy-Item -LiteralPath (Join-Path $ReleaseDirectory 'app\packaging\windows\service.ps1') -Destination (Join-Path $Root 'bin\service.ps1') -Force
    Copy-Item -LiteralPath (Join-Path $ReleaseDirectory 'app\packaging\windows\gate-crossex.ps1') -Destination (Join-Path $Root 'bin\gate-crossex.ps1') -Force

    $CurrentPath = Join-Path $Root 'current-release.txt'
    $OldRelease = if (Test-Path -LiteralPath $CurrentPath -PathType Leaf) {
        (Get-Content -LiteralPath $CurrentPath -Raw).Trim()
    } else { '' }
    if (-not [string]::IsNullOrWhiteSpace($OldRelease)) {
        $OldRelease = [IO.Path]::GetFullPath($OldRelease)
        $VersionsPrefix = [IO.Path]::GetFullPath((Join-Path $Root 'versions')).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        if (-not $OldRelease.StartsWith($VersionsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The active release pointer is outside the installation versions directory.'
        }
    }
    Stop-InstalledService $Root $TaskName $SkipService
    try {
        Backup-Database $Root $OldRelease $ReleaseDirectory $ReleaseId
    }
    catch {
        if (-not $SkipService -and -not [string]::IsNullOrWhiteSpace($OldRelease)) {
            Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        }
        throw
    }
    if (-not $SkipService -and -not (Test-PortAvailable $Port)) {
        throw "Port $Port is in use by another application. Set GCT_PORT to a free port on the first install and retry."
    }

    try {
        Set-CurrentRelease $Root $ReleaseDirectory
        Write-InstallConfig $Root $Port $TaskName $ShortcutPath
        if (-not $SkipService) {
            Register-GctTask $Root $TaskName
            Write-Shortcut $Root $ShortcutPath
            Write-Step "Starting Gate CrossEx $ReleaseId..."
            if (-not (Start-AndWait $TaskName $Port)) {
                throw 'The new release failed its health check.'
            }
        }
    }
    catch {
        $ActivationFailure = $_.Exception.Message
        $RollbackFailure = $null
        $Restored = $false
        try {
            if (-not $SkipService) {
                Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
                for ($Attempt = 0; $Attempt -lt 140; $Attempt++) {
                    if ($null -eq (Get-OwnedBackendProcessId $Root)) { break }
                    Start-Sleep -Milliseconds 250
                }
                if ($null -ne (Get-OwnedBackendProcessId $Root)) {
                    throw 'The failed backend did not stop, so rollback was not attempted.'
                }
                Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
            }
            if (-not [string]::IsNullOrWhiteSpace($OldRelease) -and (Test-Path -LiteralPath $OldRelease -PathType Container)) {
                Write-Step 'The new release failed to activate; rolling back.'
                Set-CurrentRelease $Root $OldRelease
                if ($SkipService) {
                    $Restored = $true
                }
                else {
                    Register-GctTask $Root $TaskName
                    Write-Shortcut $Root $ShortcutPath
                    $Restored = Start-AndWait $TaskName $Port
                }
            }
            else {
                Remove-Item -LiteralPath $CurrentPath -Force -ErrorAction SilentlyContinue
            }
        }
        catch {
            $RollbackFailure = $_.Exception.Message
        }
        if ($Restored) {
            throw "Installation failed ($ActivationFailure); the previous release was restored and restarted."
        }
        if ($null -ne $RollbackFailure) {
            throw "Installation failed ($ActivationFailure) and rollback failed ($RollbackFailure). Inspect $Root\logs\backend.err.log"
        }
        throw "Installation failed ($ActivationFailure) and Gate CrossEx could not be restarted. Inspect $Root\logs\backend.err.log"
    }

    Write-Host ''
    Write-Step "Installed Gate CrossEx $ReleaseId"
    Write-Host "  Start Menu: $ShortcutPath"
    Write-Host "  Local URL:  http://127.0.0.1:$Port"
    Write-Host "  Data:       $Root\data"
    Write-Host "  Commands:   powershell -NoProfile -ExecutionPolicy Bypass -File `"$Root\bin\gate-crossex.ps1`""
    Write-Host "  Uninstall:  powershell -NoProfile -ExecutionPolicy Bypass -File `"$Root\uninstall.ps1`""
    if (-not $SkipService -and $OpenBrowser -eq '1') {
        Start-Process "http://127.0.0.1:$Port"
    }
}

try {
    Install-GateCrossEx
}
catch {
    [Console]::Error.WriteLine("Gate CrossEx installation failed: $($_.Exception.Message)")
    throw
}
finally {
    if ($null -ne $Script:StageDirectory -and (Test-Path -LiteralPath $Script:StageDirectory)) {
        Remove-Item -LiteralPath $Script:StageDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $Script:TempDirectory -and (Test-Path -LiteralPath $Script:TempDirectory)) {
        Remove-Item -LiteralPath $Script:TempDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}

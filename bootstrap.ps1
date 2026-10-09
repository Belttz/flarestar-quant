param([switch]$Update)

# Gate CrossEx source bootstrap for Windows x64 and ARM64.
# Downloads a source snapshot plus a private, checksum-verified Node.js runtime,
# installs the lockfile-pinned dependencies, and leaves startup to .\run.ps1.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Script:TemporaryDirectory = $null
$Script:NewRoot = $null
$MarkerText = 'Gate CrossEx source install v1'

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

function Assert-SafeZip([string]$ArchivePath, [string]$Description) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $RootName = $null
        foreach ($Entry in $Archive.Entries) {
            $Name = $Entry.FullName.Replace('\', '/')
            $Parts = $Name.Split('/')
            if ([string]::IsNullOrWhiteSpace($Name) -or $Name.StartsWith('/') -or
                $Name.Contains(':') -or $Parts -contains '..') {
                throw "$Description contains an unsafe path: $Name"
            }
            if ([string]::IsNullOrWhiteSpace($RootName)) { $RootName = $Parts[0] }
            if ($Parts[0] -ne $RootName) { throw "$Description contains more than one top-level directory." }
        }
        if ([string]::IsNullOrWhiteSpace($RootName)) { throw "$Description is empty." }
        return $RootName
    }
    finally {
        $Archive.Dispose()
    }
}

function Assert-SafeInstallRoot([string]$InstallRoot, [string]$MarkerPath) {
    $FullPath = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
    $DriveRoot = [IO.Path]::GetPathRoot($FullPath).TrimEnd('\', '/')
    $Forbidden = @($DriveRoot, $env:USERPROFILE) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\', '/') }
    if ($Forbidden -contains $FullPath) { throw "Unsafe installation directory: $FullPath" }
    if (Test-Path -LiteralPath $FullPath -PathType Leaf) {
        throw "The installation path exists but is not a directory: $FullPath"
    }
    if ((Test-Path -LiteralPath $FullPath -PathType Container) -and
        $null -ne (Get-ChildItem -LiteralPath $FullPath -Force | Select-Object -First 1)) {
        if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
            throw "Refusing to replace a non-empty directory not created by this bootstrap: $FullPath"
        }
        if ((Get-Content -LiteralPath $MarkerPath -Raw).Trim() -ne $MarkerText) {
            throw "The source-install marker is invalid: $MarkerPath"
        }
    }
}

function Copy-PreservedPath([string]$InstallRoot, [string]$Name) {
    $Source = Join-Path $InstallRoot $Name
    if (-not (Test-Path -LiteralPath $Source)) { return }
    $Destination = Join-Path $Script:NewRoot $Name
    Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Repair-WorkspaceLinks([string]$InstallRoot) {
    $RootPath = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\', '/')
    $RootPrefix = "$RootPath\"
    $RootManifest = Get-Content -LiteralPath (Join-Path $RootPath 'package.json') -Raw | ConvertFrom-Json
    $WorkspaceValue = $RootManifest.workspaces
    if ($null -eq $WorkspaceValue) { return }
    $PackagesProperty = $WorkspaceValue.PSObject.Properties['packages']
    $Patterns = if ($null -ne $PackagesProperty) { @($PackagesProperty.Value) } else { @($WorkspaceValue) }

    foreach ($Pattern in $Patterns) {
        $NormalizedPattern = ([string]$Pattern).Replace('/', '\')
        $ManifestPattern = Join-Path $RootPath (Join-Path $NormalizedPattern 'package.json')
        foreach ($WorkspaceManifestPath in @(Get-ChildItem -Path $ManifestPattern -File -ErrorAction SilentlyContinue)) {
            $WorkspaceDirectory = $WorkspaceManifestPath.Directory.FullName
            if (-not $WorkspaceDirectory.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Workspace path escapes the installation root: $WorkspaceDirectory"
            }
            $WorkspaceManifest = Get-Content -LiteralPath $WorkspaceManifestPath.FullName -Raw | ConvertFrom-Json
            $WorkspaceName = [string]$WorkspaceManifest.name
            if ($WorkspaceName -notmatch '^(@[A-Za-z0-9._-]+/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)$') {
                throw "Invalid workspace package name: $WorkspaceName"
            }
            $LinkPath = Join-Path $RootPath (Join-Path 'node_modules' $WorkspaceName.Replace('/', '\'))
            $LinkParent = Split-Path -Parent $LinkPath
            $LinkName = Split-Path -Leaf $LinkPath
            New-Item -ItemType Directory -Path $LinkParent -Force | Out-Null
            # Get-Item can miss a junction after its staging target has moved.
            # Enumerating the parent exposes the reparse point without following
            # its now-dangling target, so it can be replaced deterministically.
            $ExistingLink = Get-ChildItem -LiteralPath $LinkParent -Force |
                Where-Object { [string]::Equals($_.Name, $LinkName, [StringComparison]::OrdinalIgnoreCase) } |
                Select-Object -First 1
            if ($null -ne $ExistingLink) {
                if (($ExistingLink.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
                    throw "Refusing to replace a non-link workspace path: $LinkPath"
                }
                Remove-Item -LiteralPath $LinkPath -Force
            }
            New-Item -ItemType Junction -Path $LinkPath -Target $WorkspaceDirectory | Out-Null
            if (-not (Test-Path -LiteralPath (Join-Path $LinkPath 'package.json') -PathType Leaf)) {
                throw "Could not repair workspace link: $LinkPath"
            }
        }
    }
}

function Install-GateCrossExSource {
    if ($env:OS -ne 'Windows_NT') { throw 'This bootstrap currently supports Windows only.' }

    $InstallRoot = [IO.Path]::GetFullPath((Get-Setting 'GCT_INSTALL_DIR' (Join-Path $env:USERPROFILE 'gate-crossex'))).TrimEnd('\', '/')
    $Marker = Join-Path $InstallRoot '.gate-crossex-source-install'
    $SavedRepository = 'Belttz/flarestar-quant'
    $SavedRef = 'main'
    $ExistingSourceConfig = Join-Path $InstallRoot '.gate-crossex-source.json'
    if (Test-Path -LiteralPath $ExistingSourceConfig -PathType Leaf) {
        try {
            $SourceConfig = Get-Content -LiteralPath $ExistingSourceConfig -Raw | ConvertFrom-Json
            if (-not [string]::IsNullOrWhiteSpace([string]$SourceConfig.repository)) { $SavedRepository = [string]$SourceConfig.repository }
            if (-not [string]::IsNullOrWhiteSpace([string]$SourceConfig.ref)) { $SavedRef = [string]$SourceConfig.ref }
        }
        catch {
            throw "The existing source metadata is invalid: $ExistingSourceConfig"
        }
    }
    $RepoSlug = Get-Setting 'GCT_REPO_SLUG' $SavedRepository
    $SourceRef = Get-Setting 'GCT_SOURCE_REF' $SavedRef
    $NodeVersion = Get-Setting 'GCT_NODE_VERSION' '24.18.0'

    if ($RepoSlug -notmatch '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$') { throw "Invalid GCT_REPO_SLUG: $RepoSlug" }
    if ($SourceRef -notmatch '^[A-Za-z0-9._-]+$') { throw "Invalid GCT_SOURCE_REF: $SourceRef" }
    if ($NodeVersion -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid GCT_NODE_VERSION: $NodeVersion" }
    Assert-SafeInstallRoot $InstallRoot $Marker

    $Architecture = Get-WindowsArchitecture
    $Script:TemporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("gate-crossex-bootstrap-" + [Guid]::NewGuid().ToString('N'))
    $Script:NewRoot = Join-Path $Script:TemporaryDirectory 'new-root'
    New-Item -ItemType Directory -Path $Script:NewRoot | Out-Null

    Write-Host ''
    Write-Step 'Preparing a self-contained Gate CrossEx source installation'

    $SourceArchive = Join-Path $Script:TemporaryDirectory 'source.zip'
    $LocalSourceArchive = [Environment]::GetEnvironmentVariable('GCT_SOURCE_ARCHIVE')
    if ([string]::IsNullOrWhiteSpace($LocalSourceArchive)) {
        Write-Step "Downloading the Gate CrossEx source ($SourceRef)..."
        Invoke-Download "https://github.com/$RepoSlug/archive/$SourceRef.zip" $SourceArchive
    }
    else {
        if (-not (Test-Path -LiteralPath $LocalSourceArchive -PathType Leaf)) {
            throw "GCT_SOURCE_ARCHIVE does not exist: $LocalSourceArchive"
        }
        Copy-Item -LiteralPath $LocalSourceArchive -Destination $SourceArchive
    }
    $ExpectedSourceHash = [Environment]::GetEnvironmentVariable('GCT_SOURCE_SHA256')
    if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceHash)) {
        $ActualSourceHash = Get-Sha256 $SourceArchive
        if ($ActualSourceHash -ne $ExpectedSourceHash) { throw 'Source archive checksum verification failed.' }
    }
    $SourceRootName = Assert-SafeZip $SourceArchive 'The source archive'
    $SourceExtraction = Join-Path $Script:TemporaryDirectory 'source-extract'
    Expand-Archive -LiteralPath $SourceArchive -DestinationPath $SourceExtraction
    $ExtractedSource = Join-Path $SourceExtraction $SourceRootName
    Get-ChildItem -LiteralPath $ExtractedSource -Force | Move-Item -Destination $Script:NewRoot

    $PackageJson = Join-Path $Script:NewRoot 'package.json'
    if (-not (Test-Path -LiteralPath $PackageJson -PathType Leaf) -or
        (Get-Content -LiteralPath $PackageJson -Raw | ConvertFrom-Json).name -ne 'gate-crossex-terminal') {
        throw 'The source archive does not identify itself as Gate CrossEx.'
    }
    foreach ($Required in @('package-lock.json', 'bootstrap.ps1', 'run.ps1', 'scripts\launcher.mjs', 'scripts\check-for-update.mjs')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Script:NewRoot $Required))) {
            throw "The source archive is missing $Required."
        }
    }

    $NodeAsset = "node-v$NodeVersion-win-$Architecture.zip"
    $NodeArchive = Join-Path $Script:TemporaryDirectory $NodeAsset
    $LocalNodeArchive = [Environment]::GetEnvironmentVariable('GCT_NODE_ARCHIVE')
    if ([string]::IsNullOrWhiteSpace($LocalNodeArchive)) {
        Write-Step "Downloading private Node.js $NodeVersion for win32-$Architecture..."
        Invoke-Download "https://nodejs.org/dist/v$NodeVersion/$NodeAsset" $NodeArchive
    }
    else {
        if (-not (Test-Path -LiteralPath $LocalNodeArchive -PathType Leaf)) {
            throw "GCT_NODE_ARCHIVE does not exist: $LocalNodeArchive"
        }
        Copy-Item -LiteralPath $LocalNodeArchive -Destination $NodeArchive
    }

    $ExpectedNodeHash = [Environment]::GetEnvironmentVariable('GCT_NODE_SHA256')
    if ([string]::IsNullOrWhiteSpace($ExpectedNodeHash)) {
        $SumsPath = Join-Path $Script:TemporaryDirectory 'SHASUMS256.txt'
        $LocalSums = [Environment]::GetEnvironmentVariable('GCT_NODE_SHASUMS')
        if ([string]::IsNullOrWhiteSpace($LocalSums)) {
            Invoke-Download "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" $SumsPath
        }
        else {
            if (-not (Test-Path -LiteralPath $LocalSums -PathType Leaf)) { throw "GCT_NODE_SHASUMS does not exist: $LocalSums" }
            Copy-Item -LiteralPath $LocalSums -Destination $SumsPath
        }
        $Pattern = '^([0-9A-Fa-f]{64})\s+\*?' + [Regex]::Escape($NodeAsset) + '$'
        $ChecksumLine = Get-Content -LiteralPath $SumsPath | Where-Object { $_ -match $Pattern } | Select-Object -First 1
        if ($null -eq $ChecksumLine) { throw "SHASUMS256.txt does not contain $NodeAsset." }
        [void]($ChecksumLine -match $Pattern)
        $ExpectedNodeHash = $Matches[1]
    }
    if ($ExpectedNodeHash -notmatch '^[0-9A-Fa-f]{64}$') { throw "Invalid SHA-256 for $NodeAsset." }
    $ActualNodeHash = Get-Sha256 $NodeArchive
    if ($ActualNodeHash -ne $ExpectedNodeHash) { throw "Node.js checksum verification failed for $NodeAsset." }
    Write-Step 'Node.js checksum verified.'

    $NodeRootName = Assert-SafeZip $NodeArchive 'The Node.js archive'
    $NodeExtraction = Join-Path $Script:TemporaryDirectory 'node-extract'
    Expand-Archive -LiteralPath $NodeArchive -DestinationPath $NodeExtraction
    $ExtractedNode = Join-Path $NodeExtraction $NodeRootName
    $RuntimeRoot = Join-Path $Script:NewRoot '.runtime'
    Move-Item -LiteralPath $ExtractedNode -Destination $RuntimeRoot
    $Node = Join-Path $RuntimeRoot 'node.exe'
    $NpmCli = Join-Path $RuntimeRoot 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $Node -PathType Leaf) -or -not (Test-Path -LiteralPath $NpmCli -PathType Leaf)) {
        throw 'The Node.js archive is missing its runtime or npm.'
    }
    if ((& $Node --version).Trim() -ne "v$NodeVersion") { throw 'The bundled Node.js runtime reported an unexpected version.' }

    $CachePath = Join-Path $Script:TemporaryDirectory 'npm-cache'
    $ExistingCache = Join-Path $InstallRoot '.local-data\npm-cache'
    if (Test-Path -LiteralPath $ExistingCache -PathType Container) { $CachePath = $ExistingCache }
    Write-Step 'Installing lockfile-pinned dependencies...'
    $PreviousPath = $env:Path
    try {
        $env:Path = "$RuntimeRoot$([IO.Path]::PathSeparator)$PreviousPath"
        Push-Location $Script:NewRoot
        try {
            & $Node $NpmCli ci --cache $CachePath --no-audit --no-fund --strict-allow-scripts
            if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
            Write-Step 'Building and checking the local application...'
            & $Node $NpmCli run build
            if ($LASTEXITCODE -ne 0) { throw 'The Gate CrossEx build failed.' }
            & $Node -e "require('better-sqlite3'); require('@napi-rs/keyring')"
            if ($LASTEXITCODE -ne 0) { throw 'The installed native dependencies cannot run on this computer.' }
        }
        finally {
            Pop-Location
        }
    }
    finally {
        $env:Path = $PreviousPath
    }

    if (Test-Path -LiteralPath $Marker -PathType Leaf) {
        $ExistingRun = Join-Path $InstallRoot 'run.ps1'
        if (Test-Path -LiteralPath $ExistingRun -PathType Leaf) {
            Write-Step 'Stopping the existing local app...'
            & $ExistingRun stop
            if ($LASTEXITCODE -ne 0) { throw 'The existing local app could not be stopped safely.' }
        }
        $Database = Join-Path $InstallRoot '.local-data\gate-crossex.sqlite'
        if (Test-Path -LiteralPath $Database -PathType Leaf) {
            $ExistingNode = Join-Path $InstallRoot '.runtime\node.exe'
            if (-not (Test-Path -LiteralPath $ExistingNode -PathType Leaf)) {
                throw 'The existing installation is missing its private Node.js runtime.'
            }
            $Timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
            $Backup = Join-Path $InstallRoot ".local-data\gate-crossex-before-bootstrap-$Timestamp.sqlite"
            Write-Step 'Creating a verified database backup...'
            Push-Location $InstallRoot
            try {
                & $ExistingNode scripts\backup-database.mjs .local-data\gate-crossex.sqlite $Backup
                if ($LASTEXITCODE -ne 0) { throw 'The database backup failed; the installation was not replaced.' }
            }
            finally {
                Pop-Location
            }
        }
    }

    foreach ($Preserved in @('.local-data', 'logs', '.env')) {
        Copy-PreservedPath $InstallRoot $Preserved
    }
    $LocalData = Join-Path $Script:NewRoot '.local-data'
    $Logs = Join-Path $Script:NewRoot 'logs'
    New-Item -ItemType Directory -Path $LocalData, $Logs -Force | Out-Null
    $LockHash = Get-Sha256 (Join-Path $Script:NewRoot 'package-lock.json')
    Set-Content -LiteralPath (Join-Path $LocalData 'dependencies.sha256') -Value $LockHash -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $Script:NewRoot '.gate-crossex-source-install') -Value $MarkerText -Encoding ASCII
    @{
        schema = 1
        repository = $RepoSlug
        ref = $SourceRef
        nodeVersion = $NodeVersion
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Script:NewRoot '.gate-crossex-source.json') -Encoding UTF8

    $Parent = Split-Path -Parent $InstallRoot
    New-Item -ItemType Directory -Path $Parent -Force | Out-Null
    Set-Location $Parent
    if (Test-Path -LiteralPath $InstallRoot) {
        $PreviousRoot = Join-Path $Parent ".gate-crossex-previous-$PID"
        if (Test-Path -LiteralPath $PreviousRoot) { throw "Temporary update path already exists: $PreviousRoot" }
        Move-Item -LiteralPath $InstallRoot -Destination $PreviousRoot
        try {
            Move-Item -LiteralPath $Script:NewRoot -Destination $InstallRoot
            $Script:NewRoot = $null
            Repair-WorkspaceLinks $InstallRoot
        }
        catch {
            $ActivationError = $_.Exception.Message
            if (Test-Path -LiteralPath $InstallRoot) {
                $FailedRoot = Join-Path $Script:TemporaryDirectory 'failed-root'
                Move-Item -LiteralPath $InstallRoot -Destination $FailedRoot
            }
            if (-not (Test-Path -LiteralPath $InstallRoot) -and (Test-Path -LiteralPath $PreviousRoot)) {
                Move-Item -LiteralPath $PreviousRoot -Destination $InstallRoot
            }
            throw "Could not activate the new source installation; the previous installation was restored. $ActivationError"
        }
        try {
            Remove-Item -LiteralPath $PreviousRoot -Recurse -Force
        }
        catch {
            Write-Warning "The update succeeded, but the previous source tree remains at $PreviousRoot"
        }
    }
    else {
        try {
            Move-Item -LiteralPath $Script:NewRoot -Destination $InstallRoot
            $Script:NewRoot = $null
            Repair-WorkspaceLinks $InstallRoot
        }
        catch {
            $ActivationError = $_.Exception.Message
            if (Test-Path -LiteralPath $InstallRoot) {
                $FailedRoot = Join-Path $Script:TemporaryDirectory 'failed-root'
                Move-Item -LiteralPath $InstallRoot -Destination $FailedRoot
            }
            throw "Could not activate the new source installation. $ActivationError"
        }
    }

    Write-Host ''
    Write-Step 'Gate CrossEx is ready to start'
    Write-Host "  Source:  $InstallRoot"
    Write-Host "  Runtime: $InstallRoot\.runtime (Node.js $NodeVersion)"
    Write-Host ''
    Write-Host 'Run:'
    Write-Host "  Set-Location `"$InstallRoot`""
    Write-Host '  .\run.ps1'
}

try {
    Install-GateCrossExSource
}
catch {
    [Console]::Error.WriteLine("Gate CrossEx bootstrap failed: $($_.Exception.Message)")
    throw
}
finally {
    if ($null -ne $Script:TemporaryDirectory -and (Test-Path -LiteralPath $Script:TemporaryDirectory)) {
        Remove-Item -LiteralPath $Script:TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}

param(
    [ValidateSet('install', 'start', 'stop', 'status', 'check')]
    [string]$Command = 'install',
    [switch]$NoBrowser,
    [switch]$NoShortcut,
    [switch]$Autostart,
    [int]$TimeoutSeconds = 900
)

# 星闪量化 FlareStar Quant · Windows 一键部署  |  Gate CrossEx Windows one-click deployment
#
# 适用场景：这台机器上已经有本项目的源码目录（开发机、或从压缩包解开的目录）。
#   双击 deploy/windows/install.bat 即可完成：自举私有 Node 运行时 → 安装依赖 → 构建 → 后台启动。
#
# 与仓库里另外两个安装器的分工（不要混淆）：
#   install.ps1   安装 GitHub Release 里打包好的发行版（普通用户用）
#   bootstrap.ps1 从 GitHub 拉源码做源码安装（无源码目录时用）
#   本脚本        就地部署「当前这份源码」，不下载源码，且不需要机器上预装 Node
#
# 常用参数：
#   -Command check      只体检、不修改任何东西（排障首选）
#   -Command status     查看运行状态
#   -NoBrowser          不自动打开浏览器
#   -NoShortcut         不创建开始菜单快捷方式
#   -Autostart          额外注册登录自启（默认关闭，不静默改系统）
#   -TimeoutSeconds N   等待服务就绪的超时秒数（默认 900，首次构建较慢）

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$RuntimeDir = Join-Path $RepoRoot '.runtime'
$PrivateNode = Join-Path $RuntimeDir 'node.exe'
$PrivateNpmCli = Join-Path $RuntimeDir 'node_modules\npm\bin\npm-cli.js'
$LockPath = Join-Path $RepoRoot 'package-lock.json'
$DataDir = Join-Path $RepoRoot '.local-data'
$LogsDir = Join-Path $RepoRoot 'logs'
$RunScript = Join-Path $RepoRoot 'run.ps1'
$TaskName = 'Gate CrossEx Terminal'
$ShortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\星闪量化 FlareStar Quant.lnk'

# 官方 Node.js 发行版里 npm 的位置就是下面这个相对路径，与 .runtime 的布局一致。
# 版本与仓库 engines 约束（^20.19.0 || >=22.13.0 <23 || >=24 <25）相符。
$NodeVersion = '22.22.2'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "  OK  $Message" -ForegroundColor Green }
function Write-Note([string]$Message) { Write-Host "  --  $Message" -ForegroundColor DarkGray }
function Write-Warn2([string]$Message) { Write-Host "  !!  $Message" -ForegroundColor Yellow }
function Fail([string]$Message) {
    Write-Host "`n[部署失败] $Message" -ForegroundColor Red
    Write-Host "[FAILED] $Message" -ForegroundColor Red
    exit 1
}

function Get-Sha256([string]$Path) {
    $Resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    $Stream = [IO.File]::OpenRead($Resolved)
    try {
        $Algorithm = [Security.Cryptography.SHA256]::Create()
        try {
            return [BitConverter]::ToString($Algorithm.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant()
        }
        finally { $Algorithm.Dispose() }
    }
    finally { $Stream.Dispose() }
}

function Test-NodeVersion([string]$Executable) {
    if ([string]::IsNullOrWhiteSpace($Executable)) { return $null }
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $null }
    # 不要用 `| Select-Object -First 1`：它会提前掐断 node 进程，留下脏的 $LASTEXITCODE。
    $Raw = $null
    try { $Raw = (& $Executable -p "process.versions.node" 2>$null) } catch { return $null }
    if ($null -eq $Raw) { return $null }
    $Text = ([string]$Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $Parts = $Text.Split('.')
    if ($Parts.Count -lt 2) { return $null }
    $Major = [int]$Parts[0]
    $Minor = [int]$Parts[1]
    $Compatible = -not (
        ($Major -eq 20 -and $Minor -lt 19) -or
        $Major -eq 21 -or
        ($Major -eq 22 -and $Minor -lt 13) -or
        $Major -lt 20 -or
        $Major -eq 23 -or
        $Major -ge 25
    )
    if (-not $Compatible) { return $null }
    return $Text
}

function Get-NodeAssetName {
    $Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    switch ($Architecture) {
        'X64' { return "node-v$NodeVersion-win-x64" }
        'Arm64' { return "node-v$NodeVersion-win-arm64" }
        default { Fail "不支持的 Windows 架构 / unsupported Windows architecture: $Architecture" }
    }
}

function Install-PrivateRuntime {
    $Asset = Get-NodeAssetName
    $ZipName = "$Asset.zip"
    $BaseUrl = "https://nodejs.org/dist/v$NodeVersion"
    $Temporary = Join-Path $env:TEMP "gate-crossex-node-$PID"
    New-Item -ItemType Directory -Force -Path $Temporary | Out-Null
    try {
        Write-Step "这台机器上没有可用的 Node.js，正在下载私有运行时 v$NodeVersion ($Asset)..."
        Write-Note 'Downloading a private Node.js runtime so no system-wide install is required.'
        $ZipPath = Join-Path $Temporary $ZipName
        Invoke-WebRequest -Uri "$BaseUrl/$ZipName" -OutFile $ZipPath -UseBasicParsing

        Write-Step '正在校验下载文件的 SHA-256（比对 Node.js 官方公布的校验和）...'
        $SumsPath = Join-Path $Temporary 'SHASUMS256.txt'
        Invoke-WebRequest -Uri "$BaseUrl/SHASUMS256.txt" -OutFile $SumsPath -UseBasicParsing
        $Expected = $null
        foreach ($Line in (Get-Content -LiteralPath $SumsPath)) {
            if ($Line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
                if ($Matches[2].Trim() -eq $ZipName) { $Expected = $Matches[1].ToLowerInvariant(); break }
            }
        }
        if ([string]::IsNullOrWhiteSpace($Expected)) { Fail "SHASUMS256.txt 中没有 $ZipName 的校验和。" }
        $Actual = Get-Sha256 $ZipPath
        if ($Actual -ne $Expected) {
            Fail "Node.js 下载校验和不匹配（期望 $Expected，实际 $Actual），已中止部署。"
        }
        Write-Ok '校验和匹配。 / checksum verified'

        $ExtractDir = Join-Path $Temporary 'extract'
        Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractDir -Force
        $Staged = Join-Path $ExtractDir $Asset
        if (-not (Test-Path -LiteralPath (Join-Path $Staged 'node.exe') -PathType Leaf)) {
            Fail 'Node.js 压缩包里没有 node.exe，下载内容异常。'
        }
        if (Test-Path -LiteralPath $RuntimeDir) { Remove-Item -LiteralPath $RuntimeDir -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
        Copy-Item -Path (Join-Path $Staged '*') -Destination $RuntimeDir -Recurse -Force
        Write-Ok "私有运行时已就位：.runtime (Node.js v$NodeVersion)"
    }
    finally {
        Remove-Item -LiteralPath $Temporary -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# 返回 @{ Node=...; Version=...; Source='private'|'system' }，找不到可用运行时就返回 $null。
function Resolve-Runtime {
    if ((Test-Path -LiteralPath $PrivateNode -PathType Leaf) -and (Test-Path -LiteralPath $PrivateNpmCli -PathType Leaf)) {
        $Version = Test-NodeVersion $PrivateNode
        if ($null -ne $Version) {
            return [pscustomobject]@{ Node = $PrivateNode; Version = $Version; Source = 'private' }
        }
    }
    $SystemNode = Get-Command node -ErrorAction SilentlyContinue
    if ($null -ne $SystemNode) {
        $Version = Test-NodeVersion $SystemNode.Source
        if ($null -ne $Version) {
            return [pscustomobject]@{ Node = $SystemNode.Source; Version = $Version; Source = 'system' }
        }
    }
    return $null
}

function Ensure-Runtime {
    $Runtime = Resolve-Runtime
    if ($null -ne $Runtime) {
        Write-Note "Node.js $($Runtime.Version)（$($Runtime.Source) runtime）"
        return $Runtime
    }
    Install-PrivateRuntime
    $Runtime = Resolve-Runtime
    if ($null -eq $Runtime) { Fail '私有 Node.js 运行时初始化失败。' }
    return $Runtime
}

function Get-ConfiguredPort {
    $ConfigPath = Join-Path $DataDir 'config.json'
    if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
        try {
            $Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
            if ($null -ne $Config.ports -and $null -ne $Config.ports.backend) { return [int]$Config.ports.backend }
        }
        catch { }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:GCT_PORT)) { return [int]$env:GCT_PORT }
    return 17840
}

function Test-Health([int]$Port) {
    try {
        $Response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
        return ($null -ne $Response -and $Response.ok -eq $true)
    }
    catch { return $false }
}

function Show-LogTail([string]$Name) {
    $Path = Join-Path $LogsDir "$Name.log"
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    Write-Host "`n--- 最近 20 行 $Name.log / last 20 lines ---" -ForegroundColor DarkGray
    Get-Content -LiteralPath $Path -Tail 20 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
}

# 以后台方式拉起 run.ps1 start：run.ps1 会在前台驻留（launcher 订阅子进程退出），
# 所以必须放到独立进程里，否则这个部署窗口会被一直占住。
function Start-InBackground {
    if (-not (Test-Path -LiteralPath $RunScript -PathType Leaf)) { Fail "找不到 run.ps1：$RunScript" }
    $env:GCT_SKIP_UPDATE_CHECK = '1'
    if ($NoBrowser) { $env:GCT_NO_OPEN = '1' }
    $PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
    Write-Step '正在安装依赖并构建（首次约 3-5 分钟），随后在后台启动服务...'
    Write-Note 'Installing pinned dependencies and building. This can take a few minutes the first time.'
    Start-Process -FilePath $PowerShell `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$RunScript`"", 'start') `
        -WorkingDirectory $RepoRoot -WindowStyle Hidden | Out-Null
}

function Wait-ForHealth([int]$Port) {
    $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $Attempt = 0
    while ((Get-Date) -lt $Deadline) {
        if (Test-Health $Port) { return $true }
        $Attempt++
        if ($Attempt % 20 -eq 0) {
            Write-Note "仍在等待服务就绪（已等待约 $([int]((Get-Date) - $Deadline.AddSeconds(-$TimeoutSeconds)).TotalSeconds) 秒）..."
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Enable-BrowserOpen([int]$Port) {
    if ($NoBrowser) { return }
    try { Start-Process "http://127.0.0.1:$Port" | Out-Null } catch { }
}

function New-ShortcutIfNeeded {
    if ($NoShortcut) { return }
    $Parent = Split-Path -Parent $ShortcutPath
    New-Item -ItemType Directory -Force -Path $Parent | Out-Null
    $PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $Self = $PSCommandPath
    $Shell = New-Object -ComObject WScript.Shell
    $Shortcut = $Shell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = $PowerShell
    $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Self`" start"
    $Shortcut.WorkingDirectory = $RepoRoot
    $Shortcut.Description = '星闪量化 FlareStar Quant 交易终端'
    $Shortcut.Save()
    Write-Ok "开始菜单快捷方式：$ShortcutPath"
}

function Register-AutostartIfRequested {
    if (-not $Autostart) { return }
    $PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $Self = $PSCommandPath
    $Action = New-ScheduledTaskAction -Execute $PowerShell `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Self`" start" `
        -WorkingDirectory $RepoRoot
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $Identity
    $Principal = New-ScheduledTaskPrincipal -UserId $Identity -LogonType Interactive -RunLevel Limited
    $Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
        -Principal $Principal -Settings $Settings -Force | Out-Null
    Write-Ok "已注册登录自启计划任务：$TaskName"
}

function Show-Summary([int]$Port) {
    Write-Host ''
    Write-Host '---------------- 部署完成 / deployment complete ----------------' -ForegroundColor Green
    Write-Host "  访问地址 / open:  http://127.0.0.1:$Port"
    Write-Host "  源码目录 / root:  $RepoRoot"
    Write-Host "  数据目录 / data:  $DataDir"
    Write-Host "  日志目录 / logs:  $LogsDir"
    Write-Host "  停止服务 / stop:  deploy\windows\stop.bat"
    Write-Host '  首次使用：在应用里配置 Gate APIv4 密钥（交易权限即可，不要开提币权限）。' -ForegroundColor DarkGray
    Write-Host ''
}

function Invoke-Check {
    Write-Step '体检模式：只读检查，不会修改任何文件。 / read-only preflight'
    $Failures = 0

    if (Test-Path -LiteralPath $LockPath -PathType Leaf) { Write-Ok 'package-lock.json 存在' }
    else { Write-Warn2 'package-lock.json 缺失'; $Failures++ }

    $Runtime = Resolve-Runtime
    if ($null -ne $Runtime) {
        Write-Ok "Node.js $($Runtime.Version)（$($Runtime.Source) runtime）"
    }
    else {
        Write-Warn2 "没有可用的 Node.js（将由 install 自动下载私有运行时 v$NodeVersion）"
    }

    $Tsx = Join-Path $RepoRoot 'node_modules\.bin\tsx.cmd'
    if (Test-Path -LiteralPath $Tsx -PathType Leaf) { Write-Ok '依赖已安装 (node_modules/.bin/tsx.cmd)' }
    else { Write-Warn2 '依赖未安装（install 会执行 npm ci）' }

    $BackendBundle = Join-Path $RepoRoot 'apps\backend\dist\server.js'
    $FrontendBundle = Join-Path $RepoRoot 'apps\frontend\dist\index.html'
    if ((Test-Path -LiteralPath $BackendBundle -PathType Leaf) -and (Test-Path -LiteralPath $FrontendBundle -PathType Leaf)) {
        Write-Ok '构建产物存在 (backend/dist, frontend/dist)'
    }
    else {
        Write-Warn2 '尚无构建产物（install 会执行 npm run build）'
    }

    if (Test-Path -LiteralPath (Join-Path $RepoRoot 'migrations') -PathType Container) { Write-Ok 'migrations 目录存在' }
    else { Write-Warn2 'migrations 目录缺失'; $Failures++ }

    $Port = Get-ConfiguredPort
    if (Test-Health $Port) { Write-Ok "服务已在运行且健康：http://127.0.0.1:$Port" }
    else { Write-Note "服务当前未运行（目标端口 $Port）" }

    Write-Host ''
    if ($Failures -gt 0) {
        Write-Host "体检结论：有 $Failures 项硬性缺失，需要先修复。 / $Failures blocking problem(s)." -ForegroundColor Red
        exit 1
    }
    Write-Host '体检结论：可以直接部署。 / ready to deploy.' -ForegroundColor Green
}

function Invoke-Status {
    $Port = Get-ConfiguredPort
    $Runtime = Resolve-Runtime
    Write-Host "  源码目录      $RepoRoot"
    if ($null -ne $Runtime) { Write-Host "  Node.js       $($Runtime.Version) ($($Runtime.Source))" } else { Write-Host '  Node.js       未就绪' }
    Write-Host "  端口          $Port"
    if (Test-Health $Port) {
        Write-Host '  服务状态      running (healthy)' -ForegroundColor Green
        Write-Host "  访问地址      http://127.0.0.1:$Port"
    }
    else {
        Write-Host '  服务状态      stopped' -ForegroundColor Yellow
    }
    Write-Host "  快捷方式      $(if (Test-Path -LiteralPath $ShortcutPath) { '已创建' } else { '无' })"
    $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Host "  登录自启      $(if ($null -ne $Task) { '已注册' } else { '未注册' })"
}

switch ($Command) {
    'check' {
        Invoke-Check
        break
    }
    'status' {
        Invoke-Status
        exit 0
    }
    'stop' {
        Ensure-Runtime | Out-Null
        & $RunScript stop
        if ($LASTEXITCODE -ne 0) { Fail "run.ps1 stop 退出码 $LASTEXITCODE" }
        exit 0
    }
    'start' {
        Ensure-Runtime | Out-Null
        $Port = Get-ConfiguredPort
        if (Test-Health $Port) {
            Write-Ok "服务已在运行：http://127.0.0.1:$Port"
            Enable-BrowserOpen $Port
            exit 0
        }
        Start-InBackground
        if (-not (Wait-ForHealth $Port)) {
            Write-Warn2 "等待 $TimeoutSeconds 秒后服务仍未就绪。"
            Show-LogTail 'backend'
            Fail '服务未能启动。请在控制台里手动执行 .\run.ps1 start 查看完整输出。'
        }
        Write-Ok '服务已就绪。 / service healthy'
        Show-Summary $Port
        exit 0
    }
    'install' {
        Write-Host ''
        Write-Host '  星闪量化 FlareStar Quant · Gate CrossEx 一键部署 (Windows)' -ForegroundColor White
        Write-Host ''
        Ensure-Runtime | Out-Null
        $Port = Get-ConfiguredPort
        if (Test-Health $Port) {
            Write-Ok "服务已在运行：http://127.0.0.1:$Port"
        }
        else {
            Start-InBackground
            if (-not (Wait-ForHealth $Port)) {
                Write-Warn2 "等待 $TimeoutSeconds 秒后服务仍未就绪。"
                Show-LogTail 'backend'
                Fail '部署未能完成。请在控制台里手动执行 .\run.ps1 start 查看完整输出。'
            }
            Write-Ok '依赖、构建与服务启动全部完成。'
        }
        New-ShortcutIfNeeded
        Register-AutostartIfRequested
        Enable-BrowserOpen $Port
        Show-Summary $Port
        exit 0
    }
}

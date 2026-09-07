# IMPORTANT: Do not modify this script without explicit user authorization.
# This is the canonical atomic source-restart procedure for this project.
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 17841,

    [ValidateRange(5, 300)]
    [int]$LauncherExitTimeoutSeconds = 30,

    [ValidateRange(5, 300)]
    [int]$RestartTimeoutSeconds = 90,

    [switch]$PrepareOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ExpectedVersion = '1.4.0'
$ExpectedRevision = '1.4.0+34cbb9a40'
$ExpectedBunSha256 = '627D2E4775C24BDEDEE2CD7CCC18DCADAE061E5345274AB6E3C4C797927BFB8F'
$SourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$GitCommonDir = (& git -C $SourceRoot rev-parse --path-format=absolute --git-common-dir 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or -not $GitCommonDir) {
    throw 'Unable to resolve the canonical repository root from Git metadata'
}
$CanonicalRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $GitCommonDir)).Path
$ConfigPath = Join-Path $env:USERPROFILE '.codex-chatgpt-web\config.json'
$RepoRoot = $SourceRoot
$ConfiguredRoot = $null
if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    $ConfiguredEntrypoint = [string](Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json).runtimeCommand[1]
    if ($ConfiguredEntrypoint -and (Test-Path -LiteralPath $ConfiguredEntrypoint -PathType Leaf)) {
        $ConfiguredRoot = (Resolve-Path -LiteralPath (Join-Path (Split-Path -Parent $ConfiguredEntrypoint) '..')).Path
        $IsKnownRepoRoot = $ConfiguredRoot.Equals($SourceRoot, [StringComparison]::OrdinalIgnoreCase) -or
            $ConfiguredRoot.Equals($CanonicalRoot, [StringComparison]::OrdinalIgnoreCase) -or
            $ConfiguredRoot.StartsWith($CanonicalRoot + '\', [StringComparison]::OrdinalIgnoreCase)
        if ($IsKnownRepoRoot -and
            (Test-Path -LiteralPath (Join-Path $ConfiguredRoot 'package.json') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $ConfiguredRoot 'launcher') -PathType Container)) {
            $RepoRoot = $ConfiguredRoot
        }
    }
}
$LauncherRoot = Join-Path $RepoRoot 'launcher'
$RuntimeCacheRoot = Join-Path $CanonicalRoot 'tmp\runtime-cache'

function Test-ExecutableRunning([string]$ExecutablePath) {
    $FullPath = [System.IO.Path]::GetFullPath($ExecutablePath)
    $Running = Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and [string]::Equals(
            [System.IO.Path]::GetFullPath([string]$_.ExecutablePath),
            $FullPath,
            [StringComparison]::OrdinalIgnoreCase
        )
    } | Select-Object -First 1
    return $null -ne $Running
}

function Test-BunCache([string]$BunPath) {
    if (-not (Test-Path -LiteralPath $BunPath -PathType Leaf)) { return $false }
    try {
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $BunPath).Hash -ne $ExpectedBunSha256) { return $false }
        return ((& $BunPath --version).Trim() -eq $ExpectedVersion) -and
            ((& $BunPath --revision).Trim() -eq $ExpectedRevision)
    } catch { return $false }
}

function Repair-BunCache([string]$BunPath) {
    if (Test-ExecutableRunning $BunPath) {
        throw "Pinned Bun cache is invalid but currently running and cannot be replaced safely: $BunPath"
    }
    $CacheDirectory = Split-Path -Parent $BunPath
    [System.IO.Directory]::CreateDirectory($CacheDirectory) | Out-Null
    $ArchivePath = Join-Path $CacheDirectory 'bun-windows-x64.zip'
    $DownloadPath = Join-Path $CacheDirectory "bun-windows-x64.$PID.zip"
    $ExtractRoot = Join-Path $CacheDirectory "extract-$PID"
    try {
        Invoke-WebRequest `
            -Uri "https://github.com/oven-sh/bun/releases/download/bun-v$ExpectedVersion/bun-windows-x64.zip" `
            -OutFile $DownloadPath | Out-Null
        if (Test-Path -LiteralPath $ExtractRoot) { Remove-Item -LiteralPath $ExtractRoot -Recurse -Force }
        Expand-Archive -LiteralPath $DownloadPath -DestinationPath $ExtractRoot
        $DownloadedBun = Get-ChildItem -LiteralPath $ExtractRoot -Filter 'bun.exe' -File -Recurse |
            Select-Object -First 1
        if ($null -eq $DownloadedBun -or
            (Get-FileHash -Algorithm SHA256 -LiteralPath $DownloadedBun.FullName).Hash -ne $ExpectedBunSha256 -or
            ((& $DownloadedBun.FullName --version).Trim() -ne $ExpectedVersion) -or
            ((& $DownloadedBun.FullName --revision).Trim() -ne $ExpectedRevision)) {
            throw "Downloaded Bun artifact did not match pinned runtime $ExpectedRevision"
        }
        Copy-Item -LiteralPath $DownloadedBun.FullName -Destination $BunPath -Force
        Move-Item -LiteralPath $DownloadPath -Destination $ArchivePath -Force
    } finally {
        if (Test-Path -LiteralPath $DownloadPath) { Remove-Item -LiteralPath $DownloadPath -Force }
        if (Test-Path -LiteralPath $ExtractRoot) { Remove-Item -LiteralPath $ExtractRoot -Recurse -Force }
    }
}

$BunCanary = Join-Path $RuntimeCacheRoot "bun\$ExpectedRevision\win32-x64\bun.exe"
if (-not (Test-BunCache $BunCanary)) { Repair-BunCache $BunCanary }
if (-not (Test-BunCache $BunCanary)) {
    throw "Pinned Bun cache verification failed after repair: $BunCanary"
}
$BunCanary = (Resolve-Path -LiteralPath $BunCanary).Path

$LauncherManifest = Get-Content -LiteralPath (Join-Path $LauncherRoot 'package.json') -Raw | ConvertFrom-Json
$ElectronVersion = [string]$LauncherManifest.devDependencies.electron
if ($ElectronVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "Launcher must declare an exact Electron version, received: $ElectronVersion"
}
$ElectronVersionRoot = Join-Path $RuntimeCacheRoot "electron\$ElectronVersion"
$ElectronDist = Join-Path $ElectronVersionRoot 'win32-x64'
$ElectronPath = Join-Path $ElectronDist 'electron.exe'
$ElectronRequiredFiles = @(
    'electron.exe',
    'version',
    'chrome_100_percent.pak',
    'chrome_200_percent.pak',
    'resources.pak',
    'icudtl.dat'
)

function Test-ElectronCache([string]$DistPath) {
    foreach ($RelativePath in $ElectronRequiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $DistPath $RelativePath) -PathType Leaf)) { return $false }
    }
    try {
        return (Get-Content -LiteralPath (Join-Path $DistPath 'version') -Raw).Trim() -eq $ElectronVersion
    } catch { return $false }
}

function Repair-ElectronCache([string]$DistPath) {
    if (Test-ExecutableRunning (Join-Path $DistPath 'electron.exe')) {
        throw "Electron cache is invalid but currently running and cannot be replaced safely: $DistPath"
    }
    [System.IO.Directory]::CreateDirectory($ElectronVersionRoot) | Out-Null
    $ArchiveName = "electron-v$ElectronVersion-win32-x64.zip"
    $ArchivePath = Join-Path $ElectronVersionRoot $ArchiveName
    $ChecksumsPath = Join-Path $ElectronVersionRoot 'SHASUMS256.txt'
    $DownloadArchive = Join-Path $ElectronVersionRoot "electron-v$ElectronVersion-win32-x64.$PID.zip"
    $DownloadChecksums = Join-Path $ElectronVersionRoot "SHASUMS256.$PID.txt"
    $ExtractRoot = Join-Path $ElectronVersionRoot "extract-$PID"
    try {
        Invoke-WebRequest `
            -Uri "https://github.com/electron/electron/releases/download/v$ElectronVersion/SHASUMS256.txt" `
            -OutFile $DownloadChecksums | Out-Null
        Invoke-WebRequest `
            -Uri "https://github.com/electron/electron/releases/download/v$ElectronVersion/$ArchiveName" `
            -OutFile $DownloadArchive | Out-Null
        $ChecksumPattern = '^\s*([0-9a-fA-F]{64})\s+\*?' + [regex]::Escape($ArchiveName) + '\s*$'
        $ChecksumMatch = Get-Content -LiteralPath $DownloadChecksums |
            ForEach-Object { [regex]::Match($_, $ChecksumPattern) } |
            Where-Object Success |
            Select-Object -First 1
        if ($null -eq $ChecksumMatch) {
            throw "Official Electron checksums did not contain $ArchiveName"
        }
        $ExpectedArchiveHash = $ChecksumMatch.Groups[1].Value.ToUpperInvariant()
        $ActualArchiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $DownloadArchive).Hash
        if ($ActualArchiveHash -ne $ExpectedArchiveHash) {
            throw "Electron archive checksum mismatch for $ArchiveName"
        }
        if (Test-Path -LiteralPath $ExtractRoot) { Remove-Item -LiteralPath $ExtractRoot -Recurse -Force }
        Expand-Archive -LiteralPath $DownloadArchive -DestinationPath $ExtractRoot
        if (-not (Test-ElectronCache $ExtractRoot)) {
            throw "Downloaded Electron payload did not match launcher version $ElectronVersion"
        }
        Move-Item -LiteralPath $DownloadArchive -Destination $ArchivePath -Force
        Move-Item -LiteralPath $DownloadChecksums -Destination $ChecksumsPath -Force
        if (Test-Path -LiteralPath $DistPath) { Remove-Item -LiteralPath $DistPath -Recurse -Force }
        Move-Item -LiteralPath $ExtractRoot -Destination $DistPath
    } finally {
        if (Test-Path -LiteralPath $DownloadArchive) { Remove-Item -LiteralPath $DownloadArchive -Force }
        if (Test-Path -LiteralPath $DownloadChecksums) { Remove-Item -LiteralPath $DownloadChecksums -Force }
        if (Test-Path -LiteralPath $ExtractRoot) { Remove-Item -LiteralPath $ExtractRoot -Recurse -Force }
    }
}

if (-not (Test-ElectronCache $ElectronDist)) { Repair-ElectronCache $ElectronDist }
if (-not (Test-ElectronCache $ElectronDist)) {
    throw "Electron cache verification failed after repair: $ElectronDist"
}
$ElectronPath = (Resolve-Path -LiteralPath $ElectronPath).Path
$InstalledVersionsRoot = Join-Path $env:USERPROFILE '.codex-chatgpt-web\versions'
$ExpectedEntrypoint = Join-Path $RepoRoot 'src\cli.ts'
$HelperOutput = Join-Path $RepoRoot '.launcher-runtime\browser-helper.cjs'
$HelperStaging = Join-Path $RepoRoot '.launcher-runtime\browser-helper.next.cjs'
$HelperBackup = Join-Path $RepoRoot '.launcher-runtime\browser-helper.previous.cjs'
$ResultPath = Join-Path $CanonicalRoot 'tmp\last-source-restart.json'
$LauncherStatePath = Join-Path $env:APPDATA 'Codex Web GPT\launcher-state.json'
$SupervisorStatePath = Join-Path $env:USERPROFILE '.codex-chatgpt-web\runtime\launcher-supervisor.json'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Result([object]$Value) {
    $TemporaryPath = "$ResultPath.next"
    [System.IO.File]::WriteAllText($TemporaryPath, ($Value | ConvertTo-Json -Depth 8), $Utf8NoBom)
    Move-Item -LiteralPath $TemporaryPath -Destination $ResultPath -Force
}

$env:CODEX_CHATGPT_WEB_BUN = $BunCanary
$env:CODEX_WEB_GPT_BUN = $BunCanary
$SourceVersion = (Get-Content -LiteralPath (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).version
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    if (-not (Test-Path -LiteralPath $ElectronPath -PathType Leaf)) {
        throw "Launcher Electron runtime was not found: $ElectronPath"
    }
    & $BunCanary run (Join-Path $RepoRoot 'scripts\build-browser-helper.ts') $HelperOutput | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $HelperOutput -PathType Leaf)) {
        throw 'Browser helper source build failed'
    }
    Push-Location $LauncherRoot
    try { & $BunCanary run build | Out-Null } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'Launcher source build failed' }
    $ExistingSetupLauncher = Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'electron.exe' -and
        $_.CommandLine -like "*$LauncherRoot*" -and
        $_.CommandLine -notlike '*--type=*' -and
        $_.CommandLine -notlike '*.launcher-runtime*'
    } | Select-Object -First 1
    if ($null -eq $ExistingSetupLauncher) {
        $ExistingSetupLauncher = Start-Process `
            -FilePath $ElectronPath `
            -ArgumentList @($LauncherRoot) `
            -WorkingDirectory $LauncherRoot `
            -PassThru
    }
    $SetupLauncherPid = if ($null -ne $ExistingSetupLauncher.PSObject.Properties['ProcessId']) {
        [int]$ExistingSetupLauncher.ProcessId
    } else {
        [int]$ExistingSetupLauncher.Id
    }
    $Result = [pscustomobject]@{
        Status = 'setup-required'
        Healthy = $false
        LauncherProcessId = $SetupLauncherPid
        SourceRoot = $RepoRoot
        Message = 'Complete full-mode setup in the source launcher, then run this script again.'
    }
    Write-Result $Result
    $Result | ConvertTo-Json
    return
}
$RuntimeConfig = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$InstalledEntrypoint = [string]$RuntimeConfig.runtimeCommand[1]
if (-not $InstalledEntrypoint) { throw 'Launcher runtime config is missing its installed entrypoint' }
if (-not (Test-Path -LiteralPath $ElectronPath -PathType Leaf)) {
    throw "Launcher Electron runtime was not found: $ElectronPath"
}

function Get-ServerListener {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function Assert-RestartableServerListener($Listener) {
    if ($null -eq $Listener) { throw "No managed server is listening on port $Port" }
    $Process = Get-CimInstance Win32_Process -Filter "ProcessId=$($Listener.OwningProcess)"
    $IsSource = $false
    if ($null -ne $Process) {
        $SourceMatch = [regex]::Match(
            [string]$Process.CommandLine,
            '(?i)(?:"([^\"]+\\src\\cli\.ts)"|(\S+\\src\\cli\.ts))\s+serve(?:\s|$)'
        )
        if ($SourceMatch.Success) {
            $SourceEntrypoint = if ($SourceMatch.Groups[1].Success) {
                $SourceMatch.Groups[1].Value
            } else {
                $SourceMatch.Groups[2].Value
            }
            if (Test-Path -LiteralPath $SourceEntrypoint -PathType Leaf) {
                $ResolvedSourceEntrypoint = (Resolve-Path -LiteralPath $SourceEntrypoint).Path
                $IsSource = $ResolvedSourceEntrypoint.StartsWith(
                    $CanonicalRoot + '\',
                    [StringComparison]::OrdinalIgnoreCase
                ) -and $ResolvedSourceEntrypoint.EndsWith(
                    '\src\cli.ts',
                    [StringComparison]::OrdinalIgnoreCase
                )
            }
        }
    }
    $InstalledVersionEntrypoint = Join-Path $InstalledVersionsRoot "$SourceVersion-*\app\cli.js"
    $IsInstalled = $null -ne $Process -and ($Process.CommandLine -like "*$InstalledEntrypoint*serve*" -or
        $Process.CommandLine -like "*$InstalledVersionEntrypoint*serve*")
    if (-not $IsSource -and -not $IsInstalled) {
        throw "Port $Port is not owned by this project's source or installed server"
    }
}

function Get-ServerHealth {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
}

function Invoke-LifecycleControl([string]$Action) {
    Invoke-RestMethod `
        -Method Post `
        -Uri "http://127.0.0.1:$Port/admin/$Action" `
        -Headers @{ Authorization = "Bearer $($RuntimeConfig.controlToken)" } `
        -TimeoutSec 5
}

function Acquire-RestartDrain {
    $Deadline = [DateTime]::UtcNow.AddSeconds($RestartTimeoutSeconds)
    $ResumeRequired = $false
    try {
        $Drain = Invoke-LifecycleControl 'drain'
        $ResumeRequired = $true
        if ($Drain.status -ne 'ok' -or $Drain.accepting_turns -ne $false -or
            -not ($Drain.active_http_turns -is [int]) -or
            -not ($Drain.active_browser_turns -is [int]) -or
            [int]$Drain.active_http_turns -lt 0 -or [int]$Drain.active_browser_turns -lt 0) {
            throw 'Server did not acknowledge the drain contract'
        }
        while ($true) {
            $Health = Get-ServerHealth
            $ActiveBrowser = [int]$Health.active_browser_turns
            if ($Health.accepting_turns -ne $false -or $ActiveBrowser -lt 0) {
                throw 'Server did not remain drained while waiting for browser turns'
            }
            if ($ActiveBrowser -eq 0) {
                try {
                    $Cancelled = Invoke-LifecycleControl 'cancel-turns-if-browser-idle'
                } catch {
                    $RetryHealth = Get-ServerHealth
                    if ($RetryHealth.accepting_turns -eq $false -and [int]$RetryHealth.active_browser_turns -gt 0) {
                        if ([DateTime]::UtcNow -ge $Deadline) {
                            throw "Server still has $([int]$RetryHealth.active_browser_turns) active browser turn(s)"
                        }
                        Start-Sleep -Milliseconds 100
                        continue
                    }
                    throw
                }
                if ($Cancelled.status -ne 'ok' -or $Cancelled.browser_idle -ne $true -or
                    [int]$Cancelled.active_http_turns -ne 0 -or [int]$Cancelled.active_browser_turns -ne 0) {
                    throw 'Server did not acknowledge browser-idle HTTP cancellation'
                }
                $ResumeRequired = $false
                return
            }
            if ([DateTime]::UtcNow -ge $Deadline) {
                throw "Server still has $ActiveBrowser active browser turn(s)"
            }
            Start-Sleep -Milliseconds 100
        }
    } catch {
        $Failure = $_
        if ($ResumeRequired) {
            try {
                $Resumed = Invoke-LifecycleControl 'resume'
                if ($Resumed.status -ne 'ok' -or $Resumed.accepting_turns -ne $true) {
                    throw 'Server did not acknowledge compensating resume'
                }
            } catch {
                throw "$($Failure.Exception.Message); compensating resume failed: $($_.Exception.Message)"
            }
        }
        throw $Failure
    }
}

function Get-SourceLauncherRootProcess {
    $Candidates = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'electron.exe' -and
        $null -ne $_.CommandLine -and
        ($_.CommandLine.IndexOf($CanonicalRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            ($ConfiguredRoot -and $_.CommandLine.IndexOf($ConfiguredRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0)) -and
        $_.CommandLine -match '[\\/]launcher(?:\s|")' -and
        $_.CommandLine -notlike '*--type=*' -and
        $_.CommandLine -notlike '*.launcher-runtime*'
    })
    if ($Candidates.Count -gt 1) {
        throw "Multiple source launcher root processes were found: $($Candidates.ProcessId -join ', ')"
    }
    $Candidates | Select-Object -First 1
}

function Get-InstalledLauncherRootProcess {
    $Candidates = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'Codex Web GPT.exe' -and
        $_.CommandLine -notlike '*--type=*' -and
        $_.CommandLine -notlike '*browser-helper.cjs*'
    })
    if ($Candidates.Count -gt 1) {
        throw "Multiple installed launcher root processes were found: $($Candidates.ProcessId -join ', ')"
    }
    $Candidates | Select-Object -First 1
}

function Get-ManagedLauncherRootProcess {
    $Candidates = @(@(Get-SourceLauncherRootProcess) + @(Get-InstalledLauncherRootProcess) | Where-Object { $null -ne $_ })
    if ($Candidates.Count -gt 1) {
        throw "Both source and installed launcher roots are running: $($Candidates.ProcessId -join ', ')"
    }
    $Candidates | Select-Object -First 1
}

function Stop-ServerGracefully([int]$ServerProcessId) {
    $Shutdown = Invoke-LifecycleControl 'shutdown'
    if ($Shutdown.status -ne 'ok') { throw 'Server did not accept the graceful shutdown request' }
    $Deadline = [DateTime]::UtcNow.AddSeconds($LauncherExitTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $Deadline) {
        $Listener = Get-ServerListener
        if ($null -eq $Listener -or [int]$Listener.OwningProcess -ne $ServerProcessId) { return }
        Start-Sleep -Milliseconds 100
    }
    throw "Server did not exit within $LauncherExitTimeoutSeconds seconds"
}

function Get-LauncherCdpPort([int]$LauncherProcessId) {
    $Renderer = Get-CimInstance Win32_Process | Where-Object {
        $_.ParentProcessId -eq $LauncherProcessId -and
        $null -ne $_.CommandLine -and
        $_.CommandLine -like '*--type=renderer*' -and
        $_.CommandLine -match '--remote-debugging-port=(\d+)'
    } | Select-Object -First 1
    if ($null -eq $Renderer -or $Renderer.CommandLine -notmatch '--remote-debugging-port=(\d+)') {
        throw 'Launcher renderer debug port was not found'
    }
    [int]$Matches[1]
}

function Request-LauncherQuit([int]$LauncherProcessId) {
    $CdpPort = Get-LauncherCdpPort $LauncherProcessId
    $PreviousCdpPort = $env:CODEX_SOURCE_RESTART_CDP_PORT
    try {
        $env:CODEX_SOURCE_RESTART_CDP_PORT = [string]$CdpPort
        $CdpScript = @'
const port = process.env.CODEX_SOURCE_RESTART_CDP_PORT;
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
for (const target of targets) {
  if (target.type !== "page" || !target.webSocketDebuggerUrl) continue;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("launcher CDP request timed out")), 5000);
      ws.addEventListener("message", event => {
        const value = JSON.parse(String(event.data));
        if (value.id === 1) { clearTimeout(timer); resolve(value); }
      });
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
        expression: `(async()=>{if(typeof window.codexWebLauncher!=="object")return "not-launcher";await window.codexWebLauncher.setPreference("keepRunningOnClose",false);window.codexWebLauncher.windowControl("close");return "scheduled"})()`,
        awaitPromise: true, returnByValue: true,
      } }));
    });
    if (result?.result?.result?.value === "scheduled") { console.log("scheduled"); process.exit(0); }
  } finally { ws.close(); }
}
throw new Error("launcher preload bridge was not found");
'@
        $Result = @($CdpScript | & $BunCanary run -)
        if ($LASTEXITCODE -ne 0 -or $Result[-1] -ne 'scheduled') {
            throw 'Launcher did not accept the graceful quit request'
        }
    } finally {
        $env:CODEX_SOURCE_RESTART_CDP_PORT = $PreviousCdpPort
    }
}

function Stop-LauncherGracefully([int]$LauncherProcessId) {
    if (-not (Test-Path -LiteralPath $LauncherStatePath -PathType Leaf)) {
        throw "Launcher state was not found: $LauncherStatePath"
    }
    $OriginalStateBytes = [System.IO.File]::ReadAllBytes($LauncherStatePath)
    try {
        Request-LauncherQuit $LauncherProcessId
        $Deadline = [DateTime]::UtcNow.AddSeconds($LauncherExitTimeoutSeconds)
        while ([DateTime]::UtcNow -lt $Deadline) {
            if ($null -eq (Get-Process -Id $LauncherProcessId -ErrorAction SilentlyContinue)) { return }
            Start-Sleep -Milliseconds 100
        }
        throw "Launcher did not exit within $LauncherExitTimeoutSeconds seconds"
    } finally {
        $RestorePath = "$LauncherStatePath.restore"
        [System.IO.File]::WriteAllBytes($RestorePath, $OriginalStateBytes)
        Move-Item -LiteralPath $RestorePath -Destination $LauncherStatePath -Force
    }
}

function Start-SourceLauncher {
    $Existing = Get-SourceLauncherRootProcess
    if ($null -ne $Existing) { return [int]$Existing.ProcessId }
    $Process = Start-Process `
        -FilePath $ElectronPath `
        -ArgumentList @($LauncherRoot, '--hidden') `
        -WorkingDirectory $LauncherRoot `
        -WindowStyle Hidden `
        -PassThru
    [int]$Process.Id
}

function Wait-ForHealthyRestart([int]$PreviousServerPid, [int]$PreviousLauncherPid) {
    $Deadline = [DateTime]::UtcNow.AddSeconds($RestartTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $Deadline) {
        $Launcher = Get-SourceLauncherRootProcess
        $Listener = Get-ServerListener
        if ($null -ne $Launcher -and [int]$Launcher.ProcessId -ne $PreviousLauncherPid -and
            $null -ne $Listener -and [int]$Listener.OwningProcess -ne $PreviousServerPid) {
            try {
                $Health = Get-ServerHealth
                if ($Health.status -eq 'ok' -and
                    $Health.version -eq $SourceVersion -and
                    $Health.pid -eq $Listener.OwningProcess -and
                    $Health.accepting_turns -eq $true) {
                    $SupervisorState = Get-Content -LiteralPath $SupervisorStatePath -Raw | ConvertFrom-Json
                    $Descriptor = Get-Content -LiteralPath $RuntimeConfig.browserHostDescriptorPath -Raw | ConvertFrom-Json
                    if ($SupervisorState.status -eq 'ready' -and
                        [int]$SupervisorState.ownerPid -eq [int]$Launcher.ProcessId -and
                        [int]$SupervisorState.daemonPid -eq [int]$Listener.OwningProcess -and
                        [int]$Descriptor.pid -eq [int]$Launcher.ProcessId) {
                        return [pscustomobject]@{
                            LauncherProcessId = [int]$Launcher.ProcessId
                            ServerProcessId = [int]$Listener.OwningProcess
                        }
                    }
                }
            } catch {}
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Full source launcher restart did not become healthy within $RestartTimeoutSeconds seconds"
}

$PreviousServerPid = 0
$PreviousLauncherPid = 0
$Drained = $false
$HelperReplaced = $false
$RestartCommitted = $false
$DowntimeStartedAt = $null
try {
    if (-not $PrepareOnly) {
        $ExistingListener = Get-ServerListener
        if ($null -ne $ExistingListener) {
            Assert-RestartableServerListener $ExistingListener
            $PreviousServerPid = [int]$ExistingListener.OwningProcess
        }
        $ExistingLauncher = Get-ManagedLauncherRootProcess
        if ($null -ne $ExistingLauncher) { $PreviousLauncherPid = [int]$ExistingLauncher.ProcessId }

    }

    & $BunCanary run (Join-Path $RepoRoot 'scripts\build-browser-helper.ts') $HelperStaging | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $HelperStaging -PathType Leaf)) {
        throw 'Browser helper source build failed'
    }
    Push-Location $LauncherRoot
    try { & $BunCanary run build | Out-Null } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'Launcher source build failed' }

    if ($PrepareOnly) {
        $Result = [pscustomobject]@{
            Status = 'prepared'
            Healthy = $true
            SourceRoot = $RepoRoot
            Version = $SourceVersion
        }
        Write-Result $Result
        $Result | ConvertTo-Json
        return
    }

    if (Test-Path -LiteralPath $HelperBackup) { Remove-Item -LiteralPath $HelperBackup -Force }
    if (Test-Path -LiteralPath $HelperOutput) {
        Move-Item -LiteralPath $HelperOutput -Destination $HelperBackup -Force
    }
    Move-Item -LiteralPath $HelperStaging -Destination $HelperOutput -Force
    $HelperReplaced = $true

    $DowntimeStartedAt = [DateTime]::UtcNow
    if ($PreviousServerPid -ne 0) {
        Acquire-RestartDrain
        $Drained = $true
    }
    if ($PreviousLauncherPid -ne 0) {
        Stop-LauncherGracefully $PreviousLauncherPid
    } elseif ($PreviousServerPid -ne 0) {
        Stop-ServerGracefully $PreviousServerPid
    }
    $Drained = $false
    $RestartCommitted = $true
    Start-SourceLauncher | Out-Null
    $Healthy = Wait-ForHealthyRestart $PreviousServerPid $PreviousLauncherPid
    $DowntimeMs = [int]([DateTime]::UtcNow - $DowntimeStartedAt).TotalMilliseconds

    if (Test-Path -LiteralPath $HelperBackup) { Remove-Item -LiteralPath $HelperBackup -Force }
    $Result = [pscustomobject]@{
        Status = $(if ($PreviousLauncherPid -ne 0 -or $PreviousServerPid -ne 0) { 'restarted' } else { 'started' })
        Healthy = $true
        PreviousLauncherProcessId = $PreviousLauncherPid
        LauncherProcessId = $Healthy.LauncherProcessId
        PreviousServerProcessId = $PreviousServerPid
        ServerProcessId = $Healthy.ServerProcessId
        DowntimeMs = $DowntimeMs
        Port = $Port
        SourceRoot = $RepoRoot
    }
    Write-Result $Result
    $Result | ConvertTo-Json
} catch {
    $Failure = $_
    if ($HelperReplaced -and (Test-Path -LiteralPath $HelperBackup)) {
        if (Test-Path -LiteralPath $HelperOutput) { Remove-Item -LiteralPath $HelperOutput -Force }
        Move-Item -LiteralPath $HelperBackup -Destination $HelperOutput -Force
    }
    if ($Drained) {
        try { Invoke-LifecycleControl 'resume' | Out-Null } catch {}
    }
    if ($RestartCommitted -and $null -eq (Get-SourceLauncherRootProcess)) {
        try { Start-SourceLauncher | Out-Null } catch {}
    }
    $Result = [pscustomobject]@{
        Status = 'failed'
        Healthy = $false
        Message = $Failure.Exception.Message
        PreviousLauncherProcessId = $PreviousLauncherPid
        PreviousServerProcessId = $PreviousServerPid
        RestartCommitted = $RestartCommitted
        SourceRoot = $RepoRoot
    }
    Write-Result $Result
    throw $Failure
} finally {
    if (Test-Path -LiteralPath $HelperStaging) {
        Remove-Item -LiteralPath $HelperStaging -Force
    }
}

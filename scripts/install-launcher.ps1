$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

function Invoke-WithRetry {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Operation,
    [Parameter(Mandatory = $true)][string]$Label
  )
  for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
    try {
      return & $Operation
    } catch {
      if ($Attempt -eq 3) {
        throw "$Label failed after $Attempt attempts: $($_.Exception.Message)"
      }
      Start-Sleep -Seconds (2 * $Attempt)
    }
  }
}

function Test-IsFullyQualifiedWindowsPath {
  param([AllowEmptyString()][string]$Path)
  return $Path -match '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))'
}

function Resolve-LatestReleaseVersion {
  param([Parameter(Mandatory = $true)][string]$Repository)
  # The public release redirect does not consume the anonymous REST API quota.
  $Response = Invoke-WithRetry -Label "Resolving the latest release" -Operation {
    Invoke-WebRequest "https://github.com/$Repository/releases/latest" -Method Head -UseBasicParsing -TimeoutSec 60
  }
  # Windows PowerShell and PowerShell expose different underlying response types.
  $ReleaseUri = if ($Response.BaseResponse.PSObject.Properties["ResponseUri"]) {
    $Response.BaseResponse.ResponseUri
  } else {
    $Response.BaseResponse.RequestMessage.RequestUri
  }
  $Prefix = "/$Repository/releases/tag/"
  if (-not $ReleaseUri -or $ReleaseUri.Scheme -ne "https" -or $ReleaseUri.Host -ne "github.com" `
      -or -not $ReleaseUri.IsDefaultPort -or -not $ReleaseUri.AbsolutePath.StartsWith($Prefix, [StringComparison]::Ordinal) `
      -or $ReleaseUri.Query -or $ReleaseUri.Fragment) {
    throw "GitHub did not redirect to an official release. Download the installer from https://github.com/$Repository/releases or set CODEX_WEB_GPT_VERSION to a published version."
  }
  $Tag = [Uri]::UnescapeDataString($ReleaseUri.AbsolutePath.Substring($Prefix.Length))
  if ($Tag -notmatch '^v?[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Invalid GitHub release tag" }
  return $Tag
}

$Repository = if ($env:CODEX_WEB_GPT_REPOSITORY) { $env:CODEX_WEB_GPT_REPOSITORY } else { "Evanlau1798/codex-chatgpt-web" }
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw "Invalid GitHub repository: $Repository"
}
$Version = $env:CODEX_WEB_GPT_VERSION
if (-not $Version) {
  $Version = Resolve-LatestReleaseVersion -Repository $Repository
}
if ($Version -and $Version.StartsWith("v")) { $Version = $Version.Substring(1) }
if (-not $Version) { throw "Could not resolve the latest Codex Web GPT release" }
if ($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Invalid release version: $Version" }

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "The packaged Windows launcher requires 64-bit Windows"
}
$Arch = "x64"

$Asset = "codex-web-gpt-$Version-win-$Arch.exe"
$BaseUrl = "https://github.com/$Repository/releases/download/v$Version"
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) "codex-web-gpt-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
  if (Get-Process -Name "Codex Web GPT" -ErrorAction SilentlyContinue) {
    throw "Quit Codex Web GPT before updating it"
  }
  $Installer = Join-Path $Temp $Asset
  $Checksums = Join-Path $Temp "checksums.txt"
  $null = Invoke-WithRetry -Label "Downloading $Asset" -Operation {
    Remove-Item $Installer -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest "$BaseUrl/$Asset" -OutFile $Installer -TimeoutSec 900 -UseBasicParsing
  }
  $null = Invoke-WithRetry -Label "Downloading checksums.txt" -Operation {
    Remove-Item $Checksums -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest "$BaseUrl/checksums.txt" -OutFile $Checksums -TimeoutSec 60 -UseBasicParsing
  }
  $ExpectedLine = Get-Content $Checksums | Where-Object { $_ -match "\s$([regex]::Escape($Asset))$" } | Select-Object -First 1
  if (-not $ExpectedLine) { throw "checksums.txt has no entry for $Asset" }
  $Expected = ($ExpectedLine -split "\s+")[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 $Installer).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw "SHA-256 verification failed for $Asset" }
  $Process = Start-Process -FilePath $Installer -ArgumentList "/S", "/currentuser" -Wait -PassThru
  if ($Process.ExitCode -ne 0) { throw "Installer exited with code $($Process.ExitCode)" }
  $InstallRegistry = "HKCU:\Software\d1a6026a-6210-588e-9a2b-da3936f94e02"
  $InstallLocation = [string](Get-ItemPropertyValue -LiteralPath $InstallRegistry -Name "InstallLocation")
  if (-not (Test-IsFullyQualifiedWindowsPath $InstallLocation)) {
    throw "Installer recorded an invalid InstallLocation: $InstallLocation"
  }
  $Executable = Join-Path $InstallLocation "Codex Web GPT.exe"
  if (-not (Test-Path $Executable)) { throw "Installed launcher was not found at $Executable" }
  Start-Process $Executable
  Write-Host "Installed $Executable"
} finally {
  Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$Installer = Join-Path $PSScriptRoot "../../scripts/install-launcher.ps1"
$Tokens = $null
$Errors = $null
$Tree = [Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$Tokens, [ref]$Errors)
if ($Errors.Count) { throw ($Errors | Out-String) }
foreach ($Name in @("Invoke-WithRetry", "Resolve-LatestReleaseVersion")) {
  $Function = $Tree.Find({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name }, $true)
  if (-not $Function) { throw "Missing installer function: $Name" }
  Invoke-Expression $Function.Extent.Text
}

$script:ResultUrl = "https://github.com/owner/repo/releases/tag/v6.0.1"
$script:Modern = $false
function Invoke-WebRequest {
  param($Uri, $Method, [switch]$UseBasicParsing, $TimeoutSec)
  if ($Uri -ne "https://github.com/owner/repo/releases/latest" -or $Method -ne "Head") {
    throw "Release lookup must use the public redirect, not the rate-limited API"
  }
  if ($script:Modern) {
    return [pscustomobject]@{ BaseResponse = [pscustomobject]@{ RequestMessage = [pscustomobject]@{ RequestUri = [uri]$script:ResultUrl } } }
  }
  return [pscustomobject]@{ BaseResponse = [pscustomobject]@{ ResponseUri = [uri]$script:ResultUrl } }
}

foreach ($ModernResponse in @($false, $true)) {
  $script:Modern = $ModernResponse
  if ((Resolve-LatestReleaseVersion -Repository "owner/repo") -ne "v6.0.1") { throw "Incorrect release version" }
}
foreach ($BadUrl in @(
  "https://example.com/owner/repo/releases/tag/v6.0.1",
  "http://github.com/owner/repo/releases/tag/v6.0.1",
  "https://github.com:8443/owner/repo/releases/tag/v6.0.1",
  "https://github.com/other/repo/releases/tag/v6.0.1",
  "https://github.com/owner/repo/releases/latest",
  "https://github.com/owner/repo/releases/tag/",
  "https://github.com/owner/repo/releases/tag/v6.0.1%2Fother",
  "https://github.com/owner/repo/releases/tag/v6.0.1?other=1"
)) {
  $script:ResultUrl = $BadUrl
  $Rejected = $false
  try { $null = Resolve-LatestReleaseVersion -Repository "owner/repo" } catch { $Rejected = $true }
  if (-not $Rejected) { throw "Accepted an invalid release redirect: $BadUrl" }
}
Write-Output "WINDOWS_INSTALLER_REDIRECT_OK"

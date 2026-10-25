param(
  [int]$Port = 17321,
  [string]$DataDir = "",
  [string]$MobileRoot = "",
  [switch]$NoMobile
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $Python)) {
  throw "Python venv not found: $Python"
}
if (-not $env:AYANA_RUNTIME_TOKEN) {
  $env:AYANA_RUNTIME_TOKEN = ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N"))
}
$arguments = @("-m", "services.agent", "--port", "$Port")
if ($DataDir) { $arguments += @("--data-dir", $DataDir) }
if ($MobileRoot) { $arguments += @("--mobile-root", $MobileRoot) }
if ($NoMobile) { $arguments += "--no-mobile" }
Push-Location $Root
try {
  & $Python @arguments
} finally {
  Pop-Location
}

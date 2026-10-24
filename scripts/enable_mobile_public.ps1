param([string]$Profile = "")
$ErrorActionPreference = "Stop"
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskDirectory = Join-Path $taskRoot ".runtime\mobile-services"
$taskTailscale = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
if (-not (Test-Path -LiteralPath $taskTailscale)) { throw "Install and sign in to Tailscale on the gateway PC first. Phones do not need Tailscale." }
$taskStatusJson = & $taskTailscale status --json
if ($LASTEXITCODE -ne 0) { throw "Unable to read Tailscale status" }
$taskStatus = $taskStatusJson | ConvertFrom-Json
if ($taskStatus.BackendState -ne "Running" -or -not $taskStatus.Self.DNSName) { throw "Tailscale must be connected with a device DNS name" }
$taskPublicUrl = "https://" + $taskStatus.Self.DNSName.TrimEnd('.')
New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null
$taskBackup = Join-Path $taskDirectory "funnel-before.json"
if (-not (Test-Path -LiteralPath $taskBackup)) {
  $taskOldConfig = & $taskTailscale funnel status --json
  if ($LASTEXITCODE -ne 0) { throw "Unable to back up the existing ingress configuration" }
  $taskOldConfig | Set-Content -LiteralPath $taskBackup -Encoding utf8
}
# Only replace the HTTPS root handler; do not reset other Tailscale services.
& $taskTailscale funnel --bg --yes --https=443 http://127.0.0.1:17330
if ($LASTEXITCODE -ne 0) { throw "Funnel could not be enabled. Check the account's Funnel permission." }
$taskConfigureArgs = @((Join-Path $PSScriptRoot "configure_mobile_services.py"), "--gateway-url", $taskPublicUrl)
if ($Profile) { $taskConfigureArgs += @("--profile", $Profile) }
Push-Location $taskRoot
try {
  & (Join-Path $taskRoot ".venv\Scripts\python.exe") @taskConfigureArgs
  if ($LASTEXITCODE -ne 0) { throw "Public activation configuration failed" }
} finally { Pop-Location }
Write-Output "Public HTTPS ingress ready. Start scripts/start_mobile_independent.ps1 if the services are stopped."
Write-Output "Existing phones: leave activation and paste the newly generated activation code. Local phone history is retained."
Write-Output "Disable this public handler: tailscale funnel --https=443 off"

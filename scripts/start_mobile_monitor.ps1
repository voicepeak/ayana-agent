param([ValidateRange(1024,65535)][int]$Port = 17340)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$MonitorDirectory = Join-Path $ProjectRoot ".runtime\mobile-monitor"
if (-not (Test-Path -LiteralPath $Python)) { throw "Python environment not found: $Python" }
foreach ($config in @("gateway.json", "worker.json")) {
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot ".runtime\mobile-services\$config"))) {
    throw "Missing existing mobile service configuration: $config"
  }
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $Port is already in use. The existing process has not been changed."
}
New-Item -ItemType Directory -Path $MonitorDirectory -Force | Out-Null
$arguments = @("-m", "services.mobile_monitor", "--root", ('"' + $ProjectRoot + '"'), "--port", "$Port")
$process = Start-Process -FilePath $Python -ArgumentList $arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $MonitorDirectory "stdout.log") `
  -RedirectStandardError (Join-Path $MonitorDirectory "stderr.log")
@{ pid = $process.Id; port = $Port; root = $ProjectRoot } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $MonitorDirectory "process.json") -Encoding utf8
$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/session" -TimeoutSec 1
    if ($response.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
  $process.Refresh()
  if ($process.HasExited) { throw "Monitor failed to start; inspect $MonitorDirectory\stderr.log" }
  Start-Sleep -Milliseconds 150
}
if (-not $ready) { throw "Monitor is not ready; inspect $MonitorDirectory\stderr.log" }
Write-Output "Read-only monitor started: http://127.0.0.1:$Port/"
Write-Output "Local login information is stored in: $MonitorDirectory"

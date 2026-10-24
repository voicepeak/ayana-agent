param(
  [string]$GatewayUrl = "",
  [string]$Profile = "",
  [switch]$ConfigureOnly
)
$ErrorActionPreference = "Stop"
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPython = Join-Path $taskRoot ".venv\Scripts\python.exe"
$taskDirectory = Join-Path $taskRoot ".runtime\mobile-services"
$taskConfigureArgs = @((Join-Path $PSScriptRoot "configure_mobile_services.py"))
if ($GatewayUrl) { $taskConfigureArgs += @("--gateway-url", $GatewayUrl) }
if ($Profile) { $taskConfigureArgs += @("--profile", $Profile) }
Push-Location $taskRoot
try {
  & $taskPython @taskConfigureArgs
  if ($LASTEXITCODE -ne 0) { throw "Mobile service configuration failed" }
  if ($ConfigureOnly) { return }
  $taskPidFile = Join-Path $taskDirectory "processes.json"
  if (Test-Path -LiteralPath $taskPidFile) {
    $taskPrevious = Get-Content -LiteralPath $taskPidFile -Raw | ConvertFrom-Json
    foreach ($taskPid in @($taskPrevious.gateway, $taskPrevious.worker)) {
      if (Get-Process -Id $taskPid -ErrorAction SilentlyContinue) {
        throw "A recorded mobile service is still running (PID $taskPid). Use scripts/stop_mobile_independent.ps1 first."
      }
    }
  }
  $taskGateway = Start-Process -FilePath $taskPython -ArgumentList @("-m", "services.gateway", "--host", "0.0.0.0") -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskDirectory "gateway.stdout.log") -RedirectStandardError (Join-Path $taskDirectory "gateway.stderr.log")
  $taskWorker = Start-Process -FilePath $taskPython -ArgumentList @("-m", "services.tts_remote") -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskDirectory "worker.stdout.log") -RedirectStandardError (Join-Path $taskDirectory "worker.stderr.log")
  @{gateway=$taskGateway.Id;worker=$taskWorker.Id;root=$taskRoot} | ConvertTo-Json | Set-Content -LiteralPath $taskPidFile -Encoding utf8
  Write-Output "Mobile gateway and SoVITS/log worker started. Open .runtime/mobile-services/activation-code.txt on this PC."
} finally { Pop-Location }

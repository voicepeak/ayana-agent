$ErrorActionPreference = "Stop"
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPidFile = Join-Path $taskRoot ".runtime\mobile-services\processes.json"
if (-not (Test-Path -LiteralPath $taskPidFile)) { return }
$taskState = Get-Content -LiteralPath $taskPidFile -Raw | ConvertFrom-Json
foreach ($taskPid in @($taskState.gateway, $taskState.worker)) {
  $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskPid" -ErrorAction SilentlyContinue
  if ($taskProcess -and $taskProcess.CommandLine -match 'services\.(gateway|tts_remote)' -and $taskProcess.ExecutablePath -like "$taskRoot\*") {
    # This tool owns these two service trees, including each venv interpreter child.
    & taskkill.exe /PID $taskPid /T /F | Out-Null
  }
}
Remove-Item -LiteralPath $taskPidFile

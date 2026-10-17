param([switch]$ResolveOnly)

$ErrorActionPreference = 'Stop'
$taskProjectRoot = Split-Path -Parent $PSScriptRoot
$taskPackage = Get-Content -LiteralPath (Join-Path $taskProjectRoot 'apps/desktop/package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskReleaseDirectory = Join-Path $taskProjectRoot 'apps/desktop/release'
$taskExecutable = Join-Path $taskReleaseDirectory ("Ayana-{0}-win-x64.exe" -f $taskPackage.version)
if (-not (Test-Path -LiteralPath $taskExecutable -PathType Leaf)) {
    Write-Error "Build the current release before launching: $taskExecutable"
    exit 1
}
if ($ResolveOnly) {
    Write-Output $taskExecutable
    exit 0
}
# Packaged launches always use the normal personal profile and bundled runtime.
foreach ($taskVariable in @('AYANA_DATA_DIR', 'AYANA_REPOSITORY_ROOT', 'AYANA_PYTHON', 'AYANA_RENDERER_URL', 'ELECTRON_RUN_AS_NODE')) {
    [Environment]::SetEnvironmentVariable($taskVariable, $null, 'Process')
}
$taskStarted = Start-Process -FilePath $taskExecutable -WorkingDirectory $taskReleaseDirectory -WindowStyle Hidden -PassThru
[pscustomobject]@{ version = $taskPackage.version; executable = $taskExecutable; pid = $taskStarted.Id } | ConvertTo-Json -Compress

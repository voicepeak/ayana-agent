[CmdletBinding()]
param(
    [string]$Python = 'py',
    [switch]$WithStt,
    [switch]$SkipNpm,
    [switch]$Package,
    [string]$AvatarRoot,
    [string]$VoiceRoot,
    [string]$SuAvatarRoot,
    [string]$SuVoiceRoot,
    [string]$BaseVoiceRoot
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentPython = Join-Path $projectRoot '.venv/Scripts/python.exe'
Push-Location -LiteralPath $projectRoot
try {
    if (-not (Test-Path -LiteralPath $environmentPython)) {
        if ($Python -eq 'py') {
            & $Python -3.11 -m venv .venv
        } else {
            & $Python -m venv .venv
        }
        if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 environment creation failed' }
    }
    & $environmentPython -c 'import sys,struct; assert sys.version_info[:2] == (3,11), "Use a Python 3.11 environment"; assert struct.calcsize("P") == 8, "Use 64-bit Python"'
    if ($LASTEXITCODE -ne 0) { throw 'Ayana requires a 64-bit Python 3.11 environment for this Windows build' }
    $extras = if ($WithStt) { '.[test,stt,browser]' } else { '.[test,browser]' }
    & $environmentPython -m pip install -e $extras
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed' }
    & $environmentPython scripts/package_backend.py --nltk-only
    if ($LASTEXITCODE -ne 0) { throw 'English pronunciation resource preparation failed' }
    if ($WithStt) {
        & $environmentPython -c 'from pathlib import Path; from huggingface_hub import snapshot_download; snapshot_download("Systran/faster-whisper-tiny", local_dir=str(Path(".runtime/models/stt/tiny")), allow_patterns=["config.json","model.bin","tokenizer.json","vocabulary.txt"]); print("Tiny speech recognition model ready")'
        if ($LASTEXITCODE -ne 0) { throw 'Tiny speech recognition model download failed' }
    }
    $resourceArguments = @('scripts/prepare_resources.py')
    if ($AvatarRoot) { $resourceArguments += @('--avatar-root', $AvatarRoot) }
    if ($VoiceRoot) { $resourceArguments += @('--voice-root', $VoiceRoot) }
    if ($SuAvatarRoot) { $resourceArguments += @('--su-avatar-root', $SuAvatarRoot) }
    if ($SuVoiceRoot) { $resourceArguments += @('--su-voice-root', $SuVoiceRoot) }
    if ($BaseVoiceRoot) { $resourceArguments += @('--base-voice-root', $BaseVoiceRoot) }
    if ($AvatarRoot -or $VoiceRoot -or $SuAvatarRoot -or $SuVoiceRoot) {
        & $environmentPython @resourceArguments
        if ($LASTEXITCODE -ne 0) { throw 'Selected resource import failed' }
    }
    if (-not $SkipNpm) {
        Push-Location -LiteralPath (Join-Path $projectRoot 'apps/desktop')
        try {
            & npm.cmd ci
            if ($LASTEXITCODE -ne 0) { throw 'Desktop dependency installation failed' }
        } finally { Pop-Location }
    }
    if ($Package) {
        & $environmentPython scripts/package_backend.py
        if ($LASTEXITCODE -ne 0) { throw 'Backend packaging failed' }
        Push-Location -LiteralPath (Join-Path $projectRoot 'apps/desktop')
        try {
            & npm.cmd run package
            if ($LASTEXITCODE -ne 0) { throw 'Desktop packaging failed' }
        } finally { Pop-Location }
    }
    Write-Host 'Ayana setup complete. Start development: cd apps/desktop; npm run dev'
} finally {
    Pop-Location
}

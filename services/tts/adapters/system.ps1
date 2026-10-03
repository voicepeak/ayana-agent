param([Parameter(Mandatory=$true)][string]$WavPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voice = $speaker.GetInstalledVoices() | Where-Object {
        $_.Enabled -and $_.VoiceInfo.Culture.Name.StartsWith('ja')
    } | Select-Object -First 1
    if ($null -eq $voice) { throw 'No installed Japanese System.Speech voice. Install a Japanese voice or configure Ayana GPT-SoVITS.' }
    $speaker.SelectVoice($voice.VoiceInfo.Name)
    $speaker.SetOutputToWaveFile($WavPath)
    $speaker.Speak($env:AYANA_TTS_TEXT)
    $speaker.SetOutputToNull()
    Write-Output $voice.VoiceInfo.Name
} finally {
    $speaker.Dispose()
}

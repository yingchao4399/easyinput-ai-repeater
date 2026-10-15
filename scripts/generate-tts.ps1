param([string]$InputPath, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$lines = @(Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json)
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'en-US' } | Select-Object -First 1
  if (-not $voice) { throw '没有安装英语语音，请安装 Windows 英语语音包' }
  $synth.SelectVoice($voice.VoiceInfo.Name)
  $synth.Rate = -1
  for ($index = 0; $index -lt $lines.Count; $index++) {
    $path = Join-Path $OutputDirectory "$index.wav"
    $synth.SetOutputToWaveFile($path)
    $synth.Speak([string]$lines[$index])
    $synth.SetOutputToNull()
  }
} finally {
  $synth.Dispose()
}

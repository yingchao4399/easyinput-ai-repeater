$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$demoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sentences = @(
  'Good morning. Let us practice one sentence at a time.',
  'I can listen, repeat, and compare my voice.',
  'Slow practice helps me hear every sound.',
  'The small keyboard keeps my hands on the lesson.',
  'Today I learned to build with artificial intelligence.'
)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = -1
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToNull()
$pcm = New-Object System.IO.MemoryStream
$srt = New-Object System.Collections.Generic.List[string]
function Stamp([double] $seconds) {
  $t = [TimeSpan]::FromMilliseconds([Math]::Round($seconds * 1000))
  return '{0:00}:{1:00}:{2:00},{3:000}' -f [int]$t.TotalHours, $t.Minutes, $t.Seconds, $t.Milliseconds
}
for ($i = 0; $i -lt $sentences.Count; $i++) {
  $part = Join-Path $demoDir ('part-{0}.wav' -f $i)
  $synth.SetOutputToWaveFile($part, $format)
  $synth.Speak($sentences[$i])
  $synth.SetOutputToNull()
  $bytes = [System.IO.File]::ReadAllBytes($part)
  $dataOffset = -1
  for ($offset = 12; $offset -le $bytes.Length - 8;) {
    $name = [System.Text.Encoding]::ASCII.GetString($bytes, $offset, 4)
    $length = [BitConverter]::ToInt32($bytes, $offset + 4)
    if ($name -eq 'data') { $dataOffset = $offset + 8; break }
    $offset += 8 + $length + ($length % 2)
  }
  if ($dataOffset -lt 0) { throw 'WAV data chunk not found' }
  $start = $pcm.Length / 32000
  $pcm.Write($bytes, $dataOffset, $length)
  $end = $pcm.Length / 32000
  $srt.Add("$($i + 1)`r`n$(Stamp $start) --> $(Stamp $end)`r`n$($sentences[$i])`r`n")
  $pcm.Write((New-Object byte[] 12800), 0, 12800)
  Remove-Item -LiteralPath $part
}
$wave = Join-Path $demoDir 'five-sentences.wav'
$stream = [System.IO.File]::Create($wave)
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
$writer.Write([int](36 + $pcm.Length))
$writer.Write([System.Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
$writer.Write([int]16)
$writer.Write([int16]1)
$writer.Write([int16]1)
$writer.Write([int]16000)
$writer.Write([int]32000)
$writer.Write([int16]2)
$writer.Write([int16]16)
$writer.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
$writer.Write([int]$pcm.Length)
$writer.Write($pcm.ToArray())
$writer.Close()
[System.IO.File]::WriteAllText((Join-Path $demoDir 'five-sentences.srt'), ($srt -join "`r`n"), [System.Text.Encoding]::UTF8)
Write-Output "Created $wave and five-sentences.srt"

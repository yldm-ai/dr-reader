# Regenerate derived assets from the original SVG; never overwrite the vector source.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$magick = Get-Command magick -ErrorAction Stop
$assetDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../resources'))
$svgPath = Join-Path $assetDirectory 'dr-reader.svg'
$pngPath = Join-Path $assetDirectory 'dr-reader.png'
$icoPath = Join-Path $assetDirectory 'dr-reader.ico'

# Preserve the non-square source on a transparent square canvas, with the same 3%
# padding used by convert-png-to-ico.ps1.
& $magick.Source -background none -density 192 $svgPath `
    -resize 962x962 -gravity center -background none -extent 1024x1024 $pngPath
if ($LASTEXITCODE -ne 0) { throw "ImageMagick failed to create the PNG: $pngPath" }

& (Join-Path $PSScriptRoot '../scripts/convert-png-to-ico.ps1') $svgPath $icoPath -Force
Write-Output "Generated dr-reader.png and dr-reader.ico from dr-reader.svg."

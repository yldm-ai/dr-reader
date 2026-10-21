# Regenerate the vector mark and Windows icon without third-party tools.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../resources'))
$svg = @'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect x="8" y="8" width="240" height="240" rx="52" fill="#56704c"/>
  <path d="M128 81C104 66 80 66 56 76V180C80 170 104 170 128 185C152 170 176 170 200 180V76C176 66 152 66 128 81ZM128 81V185" fill="none" stroke="#fafaf7" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
'@
[IO.File]::WriteAllText((Join-Path $assetDirectory 'dr-reader.svg'), $svg + "`n", [Text.UTF8Encoding]::new($false))
$background = [Drawing.Drawing2D.GraphicsPath]::new()
$background.AddArc(8, 8, 104, 104, 180, 90)
$background.AddArc(144, 8, 104, 104, 270, 90)
$background.AddArc(144, 144, 104, 104, 0, 90)
$background.AddArc(8, 144, 104, 104, 90, 90)
$background.CloseFigure()
$book = [Drawing.Drawing2D.GraphicsPath]::new()
$book.AddBezier(128, 81, 104, 66, 80, 66, 56, 76)
$book.AddLine(56, 76, 56, 180)
$book.AddBezier(56, 180, 80, 170, 104, 170, 128, 185)
$book.AddBezier(128, 185, 152, 170, 176, 170, 200, 180)
$book.AddLine(200, 180, 200, 76)
$book.AddBezier(200, 76, 176, 66, 152, 66, 128, 81)
$book.CloseFigure()
$book.StartFigure()
$book.AddLine(128, 81, 128, 185)
$brush = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#56704c'))
$pen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#fafaf7'), 10)
$pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
$pen.StartCap = $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$images = [Collections.Generic.List[byte[]]]::new()
foreach ($size in $sizes) {
    $large = [Drawing.Bitmap]::new($size * 4, $size * 4)
    $graphics = [Drawing.Graphics]::FromImage($large)
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.ScaleTransform($size * 4 / 256.0, $size * 4 / 256.0)
    $graphics.FillPath($brush, $background)
    $graphics.DrawPath($pen, $book)
    $graphics.Dispose()
    $bitmap = [Drawing.Bitmap]::new($size, $size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($large, 0, 0, $size, $size)
    $graphics.Dispose()
    $large.Dispose()
    $stream = [IO.MemoryStream]::new()
    $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
    $images.Add($stream.ToArray())
    $stream.Dispose()
    $bitmap.Dispose()
}
$stream = [IO.MemoryStream]::new()
$writer = [IO.BinaryWriter]::new($stream)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
    $writer.Write([byte]$dimension)
    $writer.Write([byte]$dimension)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$images[$i].Length)
    $writer.Write([uint32]$offset)
    $offset += $images[$i].Length
}
foreach ($bytes in $images) { $writer.Write($bytes) }
[IO.File]::WriteAllBytes((Join-Path $assetDirectory 'dr-reader.ico'), $stream.ToArray())
$writer.Dispose()
$stream.Dispose()
$pen.Dispose()
$brush.Dispose()
$book.Dispose()
$background.Dispose()
Write-Output "Generated dr-reader.svg and dr-reader.ico ($($sizes -join ', ') px)."

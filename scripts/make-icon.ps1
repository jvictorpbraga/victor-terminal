Add-Type -AssemblyName System.Drawing

$size = 1024
$out = Join-Path $PSScriptRoot "..\src-tauri\icons\source.png"

$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

# --- Rounded-square mask path ---
$radius = 200
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $radius*2, $radius*2, 180, 90)
$path.AddArc($size - $radius*2, 0, $radius*2, $radius*2, 270, 90)
$path.AddArc($size - $radius*2, $size - $radius*2, $radius*2, $radius*2, 0, 90)
$path.AddArc(0, $size - $radius*2, $radius*2, $radius*2, 90, 90)
$path.CloseFigure()

# --- Layer 1: deep navy → near-black vertical gradient base ---
$rect = New-Object System.Drawing.Rectangle 0,0,$size,$size
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  ([System.Drawing.Color]::FromArgb(255, 32, 35, 50)),
  ([System.Drawing.Color]::FromArgb(255, 12, 13, 22)),
  90.0)
$g.FillPath($bgBrush, $path)

# --- Layer 2: top-left cool highlight ---
$hl = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  ([System.Drawing.Color]::FromArgb(70, 180, 200, 240)),
  ([System.Drawing.Color]::FromArgb(0, 0, 0, 0)),
  135.0)
$g.FillPath($hl, $path)

# --- Layer 3: bottom-right warm depth ---
$rectBR = New-Object System.Drawing.Rectangle ($size/2),($size/2),($size/2),($size/2)
$br = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rectBR,
  ([System.Drawing.Color]::FromArgb(0, 0, 0, 0)),
  ([System.Drawing.Color]::FromArgb(120, 60, 40, 80)),
  135.0)
$g.FillPath($br, $path)

# --- Layer 4: diagonal sheen sweep ---
$rectS = New-Object System.Drawing.Rectangle 0,0,$size,$size
$sheen = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rectS,
  ([System.Drawing.Color]::FromArgb(0, 255, 255, 255)),
  ([System.Drawing.Color]::FromArgb(60, 255, 255, 255)),
  115.0)
$g.FillPath($sheen, $path)

# --- Inner rim highlight (1px white at top) ---
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(60, 255, 255, 255)), 4
$g.DrawPath($pen, $path)

# --- Text "Vt" with silver-metallic gradient ---
# Use a serif italic-style font to feel "fancy" — Garamond/Georgia fallback
$fontFamily = $null
foreach ($name in @("Playfair Display", "Didot", "Bodoni 72", "Georgia", "Cambria", "Times New Roman")) {
  try {
    $ff = New-Object System.Drawing.FontFamily $name
    if ($ff) { $fontFamily = $ff; break }
  } catch {}
}
if ($null -eq $fontFamily) { $fontFamily = New-Object System.Drawing.FontFamily "Georgia" }

$font = New-Object System.Drawing.Font $fontFamily, 540, ([System.Drawing.FontStyle]::Italic -bor [System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)

$textRect = New-Object System.Drawing.RectangleF 0, 60, $size, $size
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center

# Drop shadow under the text
$shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120, 0, 0, 0))
$shadowRect = New-Object System.Drawing.RectangleF 0, 76, $size, $size
$g.DrawString("Vt", $font, $shadowBrush, $shadowRect, $sf)

# Metallic silver gradient on the letters
$textGradRect = New-Object System.Drawing.RectangleF 0, 220, $size, 580
$silver = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $textGradRect,
  ([System.Drawing.Color]::FromArgb(255, 245, 250, 255)),
  ([System.Drawing.Color]::FromArgb(255, 140, 160, 200)),
  90.0)
$blend = New-Object System.Drawing.Drawing2D.ColorBlend 4
$blend.Colors = @(
  ([System.Drawing.Color]::FromArgb(255, 250, 252, 255)),
  ([System.Drawing.Color]::FromArgb(255, 200, 215, 240)),
  ([System.Drawing.Color]::FromArgb(255, 130, 150, 195)),
  ([System.Drawing.Color]::FromArgb(255, 220, 230, 250))
)
$blend.Positions = @(0.0, 0.45, 0.7, 1.0)
$silver.InterpolationColors = $blend

$g.DrawString("Vt", $font, $silver, $textRect, $sf)

# Highlight overlay across the top of the letters (extra shine)
$letterShine = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.RectangleF 0, 220, $size, 200),
  ([System.Drawing.Color]::FromArgb(180, 255, 255, 255)),
  ([System.Drawing.Color]::FromArgb(0, 255, 255, 255)),
  90.0)
# Clip to the letter bounds — approximate by drawing the letters again with a subtle white gradient
$g.DrawString("Vt", $font, $letterShine, $textRect, $sf)

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "Wrote $out"

<#
.SYNOPSIS
  Render one part of an OpenSCAD file to STL + 3MF and four PNG views, so the
  part can be checked by eye (or by Claude) before slicing.

.EXAMPLE
  .\tools\scad_render.ps1 RibbonBox\ribbon_box.scad -Part plate_pla
  .\tools\scad_render.ps1 RibbonBox\ribbon_box.scad -Part assembly   # an assembly gives coloured preview PNGs only

.NOTES
  Needs an OpenSCAD 2025+ snapshot (Manifold backend) and BOSL2 under
  $env:OPENSCADPATH (default %USERPROFILE%\Documents\OpenSCAD\libraries).
  Set $env:OPENSCAD to override the exe.
  Output goes to out\ next to the .scad file (git-ignored). Changes nothing live.
  Exits non-zero on any OpenSCAD error or warning.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Scad,
  [string]$Part,
  [int]$Size = 900,
  [switch]$NoImages
)
$ErrorActionPreference = 'Stop'

function Find-OpenScad {
  if ($env:OPENSCAD -and (Test-Path $env:OPENSCAD)) { return $env:OPENSCAD }
  $nightly = Get-ChildItem "$env:LOCALAPPDATA\Programs\OpenSCAD-nightly" -Recurse -Filter openscad.exe -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($nightly) { return $nightly.FullName }
  $cmd = Get-Command openscad -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw 'OpenSCAD not found: install a snapshot into %LOCALAPPDATA%\Programs\OpenSCAD-nightly or set $env:OPENSCAD.'
}

function Invoke-OpenScad([string[]]$ArgList) {
  # OpenSCAD logs to stderr; under 'Stop' PowerShell 5.1 would turn every line into a terminating error.
  $ErrorActionPreference = 'Continue'
  $log = & $script:exe @ArgList 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $bad = $log | Where-Object { $_ -match '^(WARNING|ERROR)' }
  if ($code -ne 0 -or $bad) {
    $log | ForEach-Object { Write-Host "  $_" }
    throw "OpenSCAD failed (exit $code) on: $($ArgList -join ' ')"
  }
}

$exe = Find-OpenScad
# Documents may be redirected to OneDrive, where OpenSCAD would look for BOSL2 by default.
if (-not $env:OPENSCADPATH) { $env:OPENSCADPATH = "$env:USERPROFILE\Documents\OpenSCAD\libraries" }
$src = (Resolve-Path $Scad).Path
$name = [IO.Path]::GetFileNameWithoutExtension($src)
if ($Part) { $name = "$name-$Part" }
$outDir = Join-Path (Split-Path $src) 'out'
New-Item -ItemType Directory -Force $outDir | Out-Null

$common = @('--hardwarnings')
# Windows PowerShell 5.1 strips bare inner quotes from native arguments, so escape them for the exe.
if ($Part) { $common += @('-D', "part=\`"$Part\`"") }

$sw = [Diagnostics.Stopwatch]::StartNew()
$isAssembly = (-not $Part -and (Select-String -Path $src -Pattern '^\s*part\s*=\s*"assembly"' -Quiet)) -or $Part -eq 'assembly'
if (-not $isAssembly) {
  $stl = Join-Path $outDir "$name.stl"
  $mf = Join-Path $outDir "$name.3mf"
  $summary = Join-Path $outDir "$name.summary.json"
  Invoke-OpenScad ($common + @('--export-format', 'binstl', '-o', $stl, '--summary', 'all', '--summary-file', $summary, $src))
  Invoke-OpenScad ($common + @('-o', $mf, $src))
  $s = Get-Content $summary -Raw | ConvertFrom-Json
  $bb = $s.geometry.bounding_box
  if ($bb) {
    $dims = (0..2 | ForEach-Object { '{0:N1}' -f ($bb.max[$_] - $bb.min[$_]) }) -join ' x '
    Write-Host "size  $dims mm"
  }
  if ($s.geometry.volume) { Write-Host ('volume {0:N0} mm3' -f $s.geometry.volume) }
  Write-Host "stl   $stl"
  Write-Host "3mf   $mf"
}

if (-not $NoImages) {
  # rot_x,y,z in the --camera translate/rotate/distance form; --viewall fits the distance.
  $views = [ordered]@{ iso = '0,0,0,55,0,25,0'; top = '0,0,0,0,0,0,0'; front = '0,0,0,90,0,0,0'; side = '0,0,0,90,0,90,0' }
  foreach ($v in $views.Keys) {
    $png = Join-Path $outDir "$name-$v.png"
    $mode = if ($isAssembly) { @() } else { @('--render') }   # assemblies keep their colours in preview
    Invoke-OpenScad ($common + $mode + @('--camera', $views[$v], '--viewall', '--autocenter', '--projection', 'o',
      '--view', 'axes,scales', '--colorscheme', 'Tomorrow', '--imgsize', "$Size,$Size", '-o', $png, $src))
    Write-Host "png   $png"
  }
}
Write-Host ('done  {0:N1} s' -f $sw.Elapsed.TotalSeconds)

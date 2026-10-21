param([string]$Generator = '', [switch]$Run)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Push-Location $projectRoot
try {
 pnpm install --frozen-lockfile
 if ($LASTEXITCODE) { throw 'Frontend dependency installation failed' }
} finally { Pop-Location }
if ($Generator) { cmake -S $projectRoot -B "$projectRoot/build" -G $Generator -A x64 }
else { cmake -S $projectRoot -B "$projectRoot/build" -A x64 }
if ($LASTEXITCODE) { throw 'CMake configure failed' }
cmake --build "$projectRoot/build" --config Release --parallel
if ($LASTEXITCODE) { throw 'Build failed' }
ctest --test-dir "$projectRoot/build" -C Release --output-on-failure
if ($LASTEXITCODE) { throw 'Tests failed' }
if ($Run) { Start-Process -FilePath "$projectRoot/build/bin/Release/dr-reader.exe" -WindowStyle Normal }

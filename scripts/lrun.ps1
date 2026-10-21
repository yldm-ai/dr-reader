[CmdletBinding()]
param(
    [string]$Generator = '',
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$AppArgs = @()
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$buildScript = Join-Path $PSScriptRoot 'build.ps1'
$executable = Join-Path $projectRoot 'build\bin\Release\dr-reader.exe'

if (-not (Test-Path -LiteralPath $buildScript -PathType Leaf)) {
    throw "Build script not found: $buildScript"
}

Push-Location $projectRoot
try {
    if ([string]::IsNullOrWhiteSpace($Generator)) {
        & $buildScript
    }
    else {
        & $buildScript -Generator $Generator
    }

    if ($LASTEXITCODE -ne 0) {
        throw "Build failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Executable not found after build: $executable"
}

& $executable @AppArgs
exit $LASTEXITCODE

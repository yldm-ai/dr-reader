param([string]$Configuration = 'Release')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$outputDirectory = Join-Path $projectRoot 'out/DRReader'
cmake --install "$projectRoot/build" --config $Configuration --component Runtime --prefix $outputDirectory
if ($LASTEXITCODE) { throw 'Install failed' }
$licensesDirectory = Join-Path $outputDirectory 'licenses'
New-Item -ItemType Directory -Force $licensesDirectory | Out-Null
$dependencyLicenses = @{
 'pugixml.txt' = 'build/_deps/pugixml-src/LICENSE.md'
 'nlohmann-json.txt' = 'build/_deps/json-src/LICENSE.MIT'
 'miniz.txt' = 'build/_deps/miniz-src/LICENSE'
 'webview2.txt' = 'build/_deps/webview2-src/LICENSE.txt'
 'webview2-notice.txt' = 'build/_deps/webview2-src/NOTICE.txt'
 'stpageflip.txt' = 'node_modules/page-flip/LICENSE'
 'material-symbols.txt' = 'node_modules/@material-symbols/svg-400/LICENSE'
}
foreach ($entry in $dependencyLicenses.GetEnumerator()) {
 $sourceLicense = Join-Path $projectRoot $entry.Value
 if (!(Test-Path -LiteralPath $sourceLicense)) { throw "Missing dependency license: $sourceLicense" }
 Copy-Item -LiteralPath $sourceLicense -Destination (Join-Path $licensesDirectory $entry.Key)
}
Copy-Item -LiteralPath "$projectRoot/THIRD_PARTY_NOTICES.md","$projectRoot/README.md" -Destination $outputDirectory
Write-Output "Portable application: $outputDirectory"

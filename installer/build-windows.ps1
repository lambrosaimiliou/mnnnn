$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

Write-Host 'Building DigitalBots web assets...' -ForegroundColor Cyan
npm run build:web
if ($LASTEXITCODE -ne 0) { throw 'Web asset build failed.' }

Write-Host 'Building the native Windows installer...' -ForegroundColor Cyan
npm run tauri:build --workspace @digitalbots/desktop
if ($LASTEXITCODE -ne 0) { throw 'Tauri Windows installer build failed.' }

$BundleDir = Join-Path $ProjectRoot 'apps/desktop/src-tauri/target/release/bundle/nsis'
$Setup = Get-ChildItem -Path $BundleDir -Filter '*-setup.exe' | Select-Object -First 1
if (-not $Setup) { throw "Tauri build finished without an NSIS setup executable in $BundleDir" }
Copy-Item -Force $Setup.FullName (Join-Path $ProjectRoot 'DigitalBotsSetup.exe')
Write-Host "Created: $ProjectRoot\DigitalBotsSetup.exe" -ForegroundColor Green

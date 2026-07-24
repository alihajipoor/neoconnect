# Fetches the real, official WireGuard for Windows binaries and drops
# just the two executables into ../resources/ -- see resources/README.md
# for why these aren't committed to git.
#
# Uses a non-installing "administrative" MSI extraction
# (msiexec /a ... TARGETDIR=...), the standard technique for pulling
# files out of an MSI without registering/installing the software
# system-wide.
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$resourcesDir = Join-Path $scriptDir "..\resources"
$tempDir = Join-Path $env:TEMP "neoconnect-wireguard-fetch"

New-Item -ItemType Directory -Force -Path $resourcesDir | Out-Null
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

$msiUrl = "https://download.wireguard.com/windows-client/wireguard-amd64-1.1.msi"
$msiPath = Join-Path $tempDir "wireguard-amd64-1.1.msi"

Write-Host "Downloading $msiUrl ..."
Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath

$extractDir = Join-Path $tempDir "extract"
Write-Host "Extracting (administrative install, not a real install)..."
$proc = Start-Process msiexec.exe -ArgumentList "/a `"$msiPath`" /qn TARGETDIR=`"$extractDir`"" -Wait -PassThru
if ($proc.ExitCode -ne 0) {
    throw "msiexec administrative extraction failed with exit code $($proc.ExitCode)"
}

Copy-Item (Join-Path $extractDir "WireGuard\wireguard.exe") (Join-Path $resourcesDir "wireguard.exe") -Force
Copy-Item (Join-Path $extractDir "WireGuard\wg.exe") (Join-Path $resourcesDir "wg.exe") -Force

Remove-Item $tempDir -Recurse -Force
Write-Host "Done -- wireguard.exe and wg.exe are in $resourcesDir"

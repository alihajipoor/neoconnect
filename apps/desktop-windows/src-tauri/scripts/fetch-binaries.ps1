# Fetches the real, official upstream engine binaries into ../resources/
# -- WireGuard, Xray, OpenVPN, and the Wintun driver they share. See
# resources/README.md for why these aren't committed to git.
#
# Every engine here is the same binary the project already trusts
# server-side; nothing is reimplemented client-side, so an upstream
# protocol fix is a version bump in this file rather than a rewrite.
#
# WireGuard uses a non-installing "administrative" MSI extraction
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
Write-Host "  wireguard.exe, wg.exe"

# --- Xray-core -------------------------------------------------------
# The Windows zip ships wintun.dll alongside xray.exe. That DLL is
# required for the TUN inbound (full-tunnel) and is loaded at runtime
# from the directory next to xray.exe, which is why both land in the
# same resources folder and are kept together.
$xrayVersion = "v26.1.23"
$xrayTemp = Join-Path $env:TEMP "neoconnect-xray-fetch"
if (Test-Path $xrayTemp) { Remove-Item $xrayTemp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $xrayTemp | Out-Null

$xrayZip = Join-Path $xrayTemp "xray.zip"
$xrayUrl = "https://github.com/XTLS/Xray-core/releases/download/$xrayVersion/Xray-windows-64.zip"
Write-Host "Downloading $xrayUrl ..."
Invoke-WebRequest -Uri $xrayUrl -OutFile $xrayZip
Expand-Archive -Path $xrayZip -DestinationPath (Join-Path $xrayTemp "extract") -Force

Copy-Item (Join-Path $xrayTemp "extract\xray.exe") (Join-Path $resourcesDir "xray.exe") -Force
$xrayWintun = Join-Path $xrayTemp "extract\wintun.dll"
if (Test-Path $xrayWintun) {
    Copy-Item $xrayWintun (Join-Path $resourcesDir "wintun.dll") -Force
    Write-Host "  xray.exe, wintun.dll"
} else {
    # Guarded rather than assumed: wintun.dll only started shipping in
    # the Xray Windows zip alongside TUN support, so a version bump that
    # predates it would otherwise produce a build that installs cleanly
    # and then fails at connect time with nothing explaining why.
    throw "wintun.dll was not in the Xray $xrayVersion zip -- Xray and OpenVPN both need it for TUN. Check the release contents before bumping the version."
}
Remove-Item $xrayTemp -Recurse -Force

# --- OpenVPN ---------------------------------------------------------
# Same administrative-extraction trick as WireGuard. Only openvpn.exe is
# taken: the config generated in service/src/engines/openvpn.rs sets
# `windows-driver wintun`, so OpenVPN reuses the Wintun driver fetched
# above instead of needing tap-windows6 as a second driver dependency.
$ovpnVersion = "2.6.12"
$ovpnTemp = Join-Path $env:TEMP "neoconnect-openvpn-fetch"
if (Test-Path $ovpnTemp) { Remove-Item $ovpnTemp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $ovpnTemp | Out-Null

$ovpnMsi = Join-Path $ovpnTemp "openvpn.msi"
$ovpnUrl = "https://swupdate.openvpn.org/community/releases/OpenVPN-$ovpnVersion-I001-amd64.msi"
Write-Host "Downloading $ovpnUrl ..."
Invoke-WebRequest -Uri $ovpnUrl -OutFile $ovpnMsi

$ovpnExtract = Join-Path $ovpnTemp "extract"
$proc = Start-Process msiexec.exe -ArgumentList "/a `"$ovpnMsi`" /qn TARGETDIR=`"$ovpnExtract`"" -Wait -PassThru
if ($proc.ExitCode -ne 0) {
    throw "msiexec administrative extraction of OpenVPN failed with exit code $($proc.ExitCode)"
}

$ovpnExe = Get-ChildItem -Path $ovpnExtract -Filter "openvpn.exe" -Recurse | Select-Object -First 1
if (-not $ovpnExe) { throw "openvpn.exe was not found in the extracted OpenVPN MSI" }
Copy-Item $ovpnExe.FullName (Join-Path $resourcesDir "openvpn.exe") -Force
Remove-Item $ovpnTemp -Recurse -Force
Write-Host "  openvpn.exe"

# --- Helper service --------------------------------------------------
# Built from this repo rather than downloaded, but it belongs in
# resources/ next to the engines: the service resolves every engine
# binary relative to its own directory (see Engines::engine_path), which
# is what keeps a caller from being able to choose what runs as SYSTEM.
Write-Host "Building the helper service..."
Push-Location (Join-Path $scriptDir "..\..")
try {
    cargo build --release -p neoconnect-service
    if ($LASTEXITCODE -ne 0) { throw "cargo build of neoconnect-service failed" }
    Copy-Item "target\release\neoconnect-service.exe" (Join-Path $resourcesDir "neoconnect-service.exe") -Force
} finally {
    Pop-Location
}
Write-Host "  neoconnect-service.exe"

Write-Host "Done -- all engine binaries are in $resourcesDir"

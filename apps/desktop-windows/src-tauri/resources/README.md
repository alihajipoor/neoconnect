# Bundled VPN engine binaries

`wireguard.exe`/`wg.exe` (and later `xray.exe`/`openvpn.exe`) are not
committed to this repo -- same "fetch the real binary at build/install
time, don't vendor it" pattern the bash installer already uses for the
server-side agent (see `installer/lib/agent.sh`).

Run `pnpm fetch-binaries` (or `powershell -File
scripts/fetch-binaries.ps1` directly from `src-tauri/`) before `pnpm
tauri dev`/`pnpm tauri build` to populate this directory.

**Provenance**: `wireguard.exe`/`wg.exe` come from the official,
BSD-licensed WireGuard for Windows MSI at
`https://download.wireguard.com/windows-client/`, extracted via a
non-installing administrative MSI extraction (`msiexec /a ... TARGETDIR=...`)
-- never actually installs WireGuard system-wide, just pulls the two
binaries out. `wireguard.exe` is what the app's Rust side spawns
(`/installtunnelservice` / `/uninstalltunnelservice`) to manage the real
tunnel; `wg.exe` is bundled alongside for future use (status queries,
`wg show`) even though v1 doesn't call it yet.

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

**WinDivert** (`WinDivert.dll`, `WinDivert.lib`, `WinDivert64.sys`) comes
from the official release at `https://github.com/basil00/WinDivert` and
backs Custom (per-app split tunnel) mode. Three files rather than one
because `windivert-sys` links against the `.lib` at build time and needs
all three in the directory named by `WINDIVERT_PATH`; the `.dll` and the
`.sys` kernel driver are what actually ship.

It is linked as a **separate DLL, never statically**. That is what keeps
WinDivert's LGPL usable in this closed-source app, so do not enable the
crate's `static`/`vendored` features without revisiting the licence
first. The `.sys` driver self-installs on the first `WinDivertOpen()`
from a process holding an admin token -- which the helper service already
has as LocalSystem -- so the end user never sees a driver install step.

; Installer hooks that register and remove the privileged helper
; service, plus the one asset the custom installer page needs.
;
; The logo path is resolved here rather than in installer.nsi because
; `__FILEDIR__` is the directory of the file being parsed, and this file
; is included by absolute path while installer.nsi is rendered into
; target/release/nsis/x64/ -- where a path relative to src-tauri would
; point at nothing.
!define NX_LOGO "${__FILEDIR__}\installer-logo.bmp"

;
; This is where the product's one and only elevation happens. The
; installer already runs elevated (installMode is perMachine), so
; registering a LocalSystem service here costs the user nothing extra --
; and in exchange, pressing Connect never raises a UAC prompt for the
; life of the installation. See service/src/main.rs for the reasoning.

; Waits for a process to actually exit, then stops asking politely.
;
; Every "Error opening file for writing" this installer has produced came
; from writing over a binary something still had open, and each time it
; was a different binary. So this is a macro rather than a special case:
; the next one is cheap to add.
;
; Ten seconds is far longer than any clean shutdown here needs.
!macro WaitForProcessGone _exe
  StrCpy $2 0
  ${Do}
    nsExec::ExecToLog 'cmd /c tasklist /FI "IMAGENAME eq ${_exe}" /NH | find /I "${_exe}"'
    Pop $0
    ${If} $0 != 0
      ${ExitDo}
    ${EndIf}
    Sleep 500
    IntOp $2 $2 + 1
    ${If} $2 >= 20
      nsExec::ExecToLog 'taskkill /F /IM ${_exe}'
      Pop $0
      Sleep 1000
      ${ExitDo}
    ${EndIf}
  ${Loop}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; A running service holds its own executable open, so installing over
  ; an existing install fails with "Error opening file for writing"
  ; unless the old service is stopped and removed first. This runs before
  ; any file is written, and matters for every upgrade and auto-update,
  ; not just a manual reinstall.
  ;
  ; The executable being invoked here is the *previous* version's, which
  ; is fine -- `uninstall` has the same meaning in every build, and it
  ; waits for the process to actually exit rather than just requesting a
  ; stop (see uninstall() in service/src/main.rs).
  ;
  ; Silent no-op on a first install, where the file doesn't exist yet.
  ${If} ${FileExists} "$INSTDIR\resources\neoconnect-service.exe"
    nsExec::ExecToLog '"$INSTDIR\resources\neoconnect-service.exe" uninstall'
    Pop $0
  ${EndIf}

  ; The product was renamed from NeoConnect to Neoxify, which moved
  ; $INSTDIR from "Program Files\NeoConnect" to "Program Files\Neoxify".
  ; Anyone upgrading from a pre-rename build therefore has a running
  ; service registered from a directory the check above never looks at:
  ; it would be left running, holding the old binary open, while this
  ; install tries to register a service under the same name.
  ;
  ; Handled by name rather than by path, via sc.exe, so it works no matter
  ; where the old build put itself.
  ;
  ; BOTH names are removed. The rename changed the registered service from
  ; NeoConnectService to NeoxifyService, so a machine upgrading from a
  ; pre-rename build has the old one still registered, running, and holding
  ; a binary open in a directory this installer never looks at. Only
  ; removing the new name would leave it there forever.
  ;
  ; (An earlier version of this hook used "neoconnect-service", which is
  ; the executable's filename and was never the service name -- it matched
  ; nothing on any machine.)
  ;
  ; All four calls fail harmlessly on a clean machine.
  nsExec::ExecToLog 'sc.exe stop NeoConnectService'
  Pop $0
  nsExec::ExecToLog 'sc.exe delete NeoConnectService'
  Pop $0
  nsExec::ExecToLog 'sc.exe stop NeoxifyService'
  Pop $0
  nsExec::ExecToLog 'sc.exe delete NeoxifyService'
  Pop $0

  ; None of the above waits for anything. sc.exe stop returns once the
  ; Service Control Manager has *accepted* the request, and sc.exe delete
  ; only marks the service for removal -- the executable stays open until
  ; the process itself exits. So the installer could start writing while
  ; the old binary was still locked, which fails the whole install with
  ; "Error opening file for writing".
  ;
  ; Usually the process exits fast enough to hide this. It stops hiding
  ; when the service is mid-operation -- observed after the app was killed
  ; from Task Manager during a connection attempt.

  ; The helper service is not the only thing holding a file. wireguard.exe
  ; /installtunnelservice registers a Windows service of its own, running
  ; that same executable, and the helper service normally removes it on
  ; disconnect. A helper that was killed rather than stopped never got
  ; there, so the tunnel outlives it and keeps wireguard.exe open --
  ; which is exactly the second failure this installer hit, one build
  ; after the first was fixed.
  ;
  ; Asked nicely first, because /uninstalltunnelservice also tears the
  ; network adapter down cleanly, which killing the process does not.
  ${If} ${FileExists} "$INSTDIR\resources\wireguard.exe"
    nsExec::ExecToLog '"$INSTDIR\resources\wireguard.exe" /uninstalltunnelservice neoconnect'
    Pop $0
  ${EndIf}
  ; By name as well, so it still works when the executable is missing or
  ; refuses. $$ is a literal dollar -- the service really is called
  ; WireGuardTunnel$neoconnect.
  nsExec::ExecToLog 'sc.exe stop WireGuardTunnel$$neoconnect'
  Pop $0
  nsExec::ExecToLog 'sc.exe delete WireGuardTunnel$$neoconnect'
  Pop $0

  ; Xray and OpenVPN are plain child processes of the helper service, so a
  ; killed helper orphans them holding their own binaries open too. Same
  ; problem, same treatment -- and cheaper to handle now than to discover
  ; one build at a time.
  !insertmacro WaitForProcessGone "neoconnect-service.exe"
  !insertmacro WaitForProcessGone "wireguard.exe"
  !insertmacro WaitForProcessGone "xray.exe"
  !insertmacro WaitForProcessGone "openvpn.exe"

  ; WinDivert's kernel driver, used by Custom mode. WinDivert registers it
  ; as a service on first use and unregisters it when the last handle
  ; closes -- which the helper service does on disconnect and on stop, so
  ; by this point it is usually already gone. "Usually" is not good
  ; enough here: a loaded driver holds WinDivert64.sys open, and this
  ; installer's entire history of "Error opening file for writing" is
  ; binaries something still had open.
  ;
  ; Note the helper service now links WinDivert.dll implicitly, so it will
  ; not start at all if that file is missing -- which makes writing over
  ; these two successfully a hard requirement, not a nicety.
  nsExec::ExecToLog 'sc.exe stop WinDivert'
  Pop $0
  nsExec::ExecToLog 'sc.exe delete WinDivert'
  Pop $0

  ; The old install directory is left in place rather than deleted here.
  ; Removing files from a path this installer does not own is the kind of
  ; thing that goes badly wrong if the assumption is ever off, and a stale
  ; directory is harmless once its service is gone -- the user can remove
  ; the old entry from Add/Remove Programs.
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; The service registers itself, rather than the installer hand-writing
  ; registry keys, so there is exactly one definition of what the service
  ; is (ServiceInfo in main.rs) instead of two that can drift.
  nsExec::ExecToLog '"$INSTDIR\resources\neoconnect-service.exe" install'
  Pop $0

  ; Verified rather than trusted. A real install of this build left the app
  ; unable to connect at all: the service was simply not registered, and
  ; because the failure only produced a DetailPrint on a page nobody reads,
  ; the installer finished looking completely successful. Asking Windows
  ; whether the service actually exists is the only honest check.
  nsExec::ExecToLog 'sc.exe query NeoxifyService'
  Pop $1
  ${If} $1 != 0
    ; Retried once before giving up -- registration can lose a race with
    ; the Service Control Manager still releasing a just-deleted name.
    Sleep 2000
    nsExec::ExecToLog '"$INSTDIR\resources\neoconnect-service.exe" install'
    Pop $0
    nsExec::ExecToLog 'sc.exe query NeoxifyService'
    Pop $1
  ${EndIf}

  ${If} $1 != 0
    ; Deliberately a MessageBox, not a DetailPrint. Without the service the
    ; app installs and launches but cannot connect to anything, which reads
    ; to the user as a broken product rather than a failed step -- they
    ; should find out now, while they still have the installer open, not on
    ; their first attempt to use it.
    MessageBox MB_ICONEXCLAMATION|MB_OK "Neoxify installed, but its background service could not be registered (code $0).$\r$\n$\r$\nConnecting will not work until this is fixed. Try running the installer again as administrator."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop and delete before files are removed -- a running service holds
  ; its own executable open, which would otherwise leave the install
  ; directory undeletable.
  nsExec::ExecToLog '"$INSTDIR\resources\neoconnect-service.exe" uninstall'
  Pop $0

  ; And the tunnel service, for the same reason it matters on install: it
  ; is registered by wireguard.exe rather than by us, and outlives a
  ; helper that was killed rather than stopped.
  ${If} ${FileExists} "$INSTDIR\resources\wireguard.exe"
    nsExec::ExecToLog '"$INSTDIR\resources\wireguard.exe" /uninstalltunnelservice neoconnect'
    Pop $0
  ${EndIf}
  nsExec::ExecToLog 'sc.exe stop WireGuardTunnel$$neoconnect'
  Pop $0
  nsExec::ExecToLog 'sc.exe delete WireGuardTunnel$$neoconnect'
  Pop $0

  !insertmacro WaitForProcessGone "neoconnect-service.exe"
  !insertmacro WaitForProcessGone "wireguard.exe"
  !insertmacro WaitForProcessGone "xray.exe"
  !insertmacro WaitForProcessGone "openvpn.exe"

  ; WinDivert's kernel driver, used by Custom mode. WinDivert registers it
  ; as a service on first use and unregisters it when the last handle
  ; closes -- which the helper service does on disconnect and on stop, so
  ; by this point it is usually already gone. "Usually" is not good
  ; enough here: a loaded driver holds WinDivert64.sys open, and this
  ; installer's entire history of "Error opening file for writing" is
  ; binaries something still had open.
  ;
  ; Note the helper service now links WinDivert.dll implicitly, so it will
  ; not start at all if that file is missing -- which makes writing over
  ; these two successfully a hard requirement, not a nicety.
  nsExec::ExecToLog 'sc.exe stop WinDivert'
  Pop $0
  nsExec::ExecToLog 'sc.exe delete WinDivert'
  Pop $0
!macroend

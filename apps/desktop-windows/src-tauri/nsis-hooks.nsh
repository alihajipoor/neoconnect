; Installer hooks that register and remove the privileged helper
; service.
;
; This is where the product's one and only elevation happens. The
; installer already runs elevated (installMode is perMachine), so
; registering a LocalSystem service here costs the user nothing extra --
; and in exchange, pressing Connect never raises a UAC prompt for the
; life of the installation. See service/src/main.rs for the reasoning.

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
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; The service registers itself, rather than the installer hand-writing
  ; registry keys, so there is exactly one definition of what the service
  ; is (ServiceInfo in main.rs) instead of two that can drift.
  nsExec::ExecToLog '"$INSTDIR\resources\neoconnect-service.exe" install'
  Pop $0
  ${If} $0 != 0
    ; Not fatal: the app installs fine and will show a clear "could not
    ; reach the background service" message on Connect. Failing the whole
    ; install here would be a worse outcome than a working app that can't
    ; tunnel yet.
    DetailPrint "Warning: could not register the Neoxify background service (code $0). Connecting will not work until this is resolved."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop and delete before files are removed -- a running service holds
  ; its own executable open, which would otherwise leave the install
  ; directory undeletable.
  nsExec::ExecToLog '"$INSTDIR\resources\neoconnect-service.exe" uninstall'
  Pop $0
!macroend

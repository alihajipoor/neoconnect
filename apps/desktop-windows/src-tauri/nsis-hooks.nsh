; Installer hooks that register and remove the privileged helper
; service.
;
; This is where the product's one and only elevation happens. The
; installer already runs elevated (installMode is perMachine), so
; registering a LocalSystem service here costs the user nothing extra --
; and in exchange, pressing Connect never raises a UAC prompt for the
; life of the installation. See service/src/main.rs for the reasoning.

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
    DetailPrint "Warning: could not register the NeoConnect background service (code $0). Connecting will not work until this is resolved."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Stop and delete before files are removed -- a running service holds
  ; its own executable open, which would otherwise leave the install
  ; directory undeletable.
  nsExec::ExecToLog '"$INSTDIR\resources\neoconnect-service.exe" uninstall'
  Pop $0
!macroend

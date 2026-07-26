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

  ; The product was renamed from NeoConnect to Neoxify, which moved
  ; $INSTDIR from "Program Files\NeoConnect" to "Program Files\Neoxify".
  ; Anyone upgrading from a pre-rename build therefore has a running
  ; service registered from a directory the check above never looks at:
  ; it would be left running, holding the old binary open, while this
  ; install tries to register a service under the same name.
  ;
  ; Handled by name rather than by path, via sc.exe, so it works no matter
  ; where the old build put itself. The service name is deliberately
  ; unchanged across the rename (see the branding notes) precisely so this
  ; still finds it.
  ;
  ; Both calls are expected to fail harmlessly on a clean machine where
  ; there is nothing to stop or delete.
  nsExec::ExecToLog 'sc.exe stop neoconnect-service'
  Pop $0
  nsExec::ExecToLog 'sc.exe delete neoconnect-service'
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

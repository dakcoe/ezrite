; Ezrite NSIS additions (electron-builder nsis.include). ASCII only.
; On a real uninstall (not an update), remove what the installer and the app keep outside the install folder:
;   - the installer copy electron-builder stores for updates  (%LOCALAPPDATA%\ezrite-updater)
;   - the Chromium cache the app keeps                        (%LOCALAPPDATA%\Ezrite, see main.js setPath userData)
; The user's keys, notes and settings in %APPDATA%\Ezrite are never removed.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\ezrite-updater"
    RMDir /r "$LOCALAPPDATA\Ezrite"
  ${endIf}
!macroend

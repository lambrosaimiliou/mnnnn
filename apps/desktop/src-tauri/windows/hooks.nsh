!macro NSIS_HOOK_POSTINSTALL
  ; The shortcut is per-user and points to the installed Tauri executable.
  CreateShortCut "$DESKTOP\DigitalBots.lnk" "$INSTDIR\DigitalBots.exe" "" "$INSTDIR\DigitalBots.exe" 0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$DESKTOP\DigitalBots.lnk"
!macroend

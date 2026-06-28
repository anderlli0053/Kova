; Remove any legacy per-machine desktop shortcut left over from installs that used
; installMode "both" (which silently defaulted to perMachine and placed the shortcut
; under C:\Users\Public\Desktop rather than the current user's desktop).
; This runs before the new shortcut is created so upgrading users end up with
; exactly one shortcut in their own desktop.
!macro NSIS_HOOK_PREINSTALL
  Delete "$COMMON_DESKTOP\Kova.lnk"
!macroend

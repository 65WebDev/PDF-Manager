; NSIS hooks for PDF Manager (Tauri).
; Goal: force Windows to pick up the new app / file-association icons after upgrade.
; Explorer caches shortcut + ProgId icons aggressively; a versioned .ico filename busts that cache.

!macro NSIS_HOOK_POSTINSTALL
  ; Sidecar icon shipped via bundle.resources (cache-busting filename).
  StrCpy $R9 "$INSTDIR\icons\pdf-manager-icon-v018.ico"

  ${If} ${FileExists} "$R9"
    ; Uninstall / ARP list icon
    WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$R9$\",0"

    ; File association ProgId icon (Tauri uses association.name → "PDF Document")
    WriteRegStr SHCTX "Software\Classes\PDF Document\DefaultIcon" "" "$\"$R9$\",0"
    ; Also cover a space-stripped / dotted ProgId variants if present
    WriteRegStr SHCTX "Software\Classes\PDFManager.PDF\DefaultIcon" "" "$\"$R9$\",0"
    WriteRegStr SHCTX "Software\Classes\io.github.pdfmanager.desktop\DefaultIcon" "" "$\"$R9$\",0"

    ; Recreate Start Menu shortcut with an explicit icon path
    ${If} $AppStartMenuFolder != ""
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$R9" 0
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    ${Else}
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$R9" 0
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Recreate Desktop shortcut with the same explicit icon
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$R9" 0
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}

  ; Ask Explorer to reload associations / icons
  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'shell32.dll::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

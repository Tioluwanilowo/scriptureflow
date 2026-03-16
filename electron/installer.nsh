; Custom NSIS installer script for ScriptureFlow
; Adds Windows Firewall rules and hydrates the NDI 6 runtime DLL at install time.

!macro customInstall
  ; Remove any stale rule first (ignore errors if it doesn't exist)
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="ScriptureFlow NDI"'

  ; Allow inbound NDI traffic (receivers connecting to this source)
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="ScriptureFlow NDI" dir=in action=allow program="$INSTDIR\ScriptureFlow.exe" protocol=any'

  ; Allow outbound NDI traffic (discovery multicast + streaming)
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="ScriptureFlow NDI" dir=out action=allow program="$INSTDIR\ScriptureFlow.exe" protocol=any'

  ; Locate NDI 6 runtime DLL from common install paths (Tools + Runtime variants)
  StrCpy $0 ""

  IfFileExists "$PROGRAMFILES64\NDI\NDI 6 Tools\Runtime\Processing.NDI.Lib.x64.dll" 0 +2
    StrCpy $0 "$PROGRAMFILES64\NDI\NDI 6 Tools\Runtime\Processing.NDI.Lib.x64.dll"
  IfFileExists "$0" ndi_copy 0

  IfFileExists "$PROGRAMFILES64\NDI\NDI 6 Tools\Router\Processing.NDI.Lib.x64.dll" 0 +2
    StrCpy $0 "$PROGRAMFILES64\NDI\NDI 6 Tools\Router\Processing.NDI.Lib.x64.dll"
  IfFileExists "$0" ndi_copy 0

  IfFileExists "$PROGRAMFILES64\NDI\NDI 6 Runtime\v6\Processing.NDI.Lib.x64.dll" 0 +2
    StrCpy $0 "$PROGRAMFILES64\NDI\NDI 6 Runtime\v6\Processing.NDI.Lib.x64.dll"
  IfFileExists "$0" ndi_copy 0

  IfFileExists "$PROGRAMFILES64\NDI\NDI 6 Runtime\Processing.NDI.Lib.x64.dll" 0 +2
    StrCpy $0 "$PROGRAMFILES64\NDI\NDI 6 Runtime\Processing.NDI.Lib.x64.dll"
  IfFileExists "$0" ndi_copy 0

  IfFileExists "$PROGRAMFILES\NDI\NDI 6 Tools\Runtime\Processing.NDI.Lib.x64.dll" 0 +2
    StrCpy $0 "$PROGRAMFILES\NDI\NDI 6 Tools\Runtime\Processing.NDI.Lib.x64.dll"
  IfFileExists "$0" ndi_copy 0

  IfFileExists "$PROGRAMFILES\NDI\NDI 6 Tools\Router\Processing.NDI.Lib.x64.dll" 0 +2
    StrCpy $0 "$PROGRAMFILES\NDI\NDI 6 Tools\Router\Processing.NDI.Lib.x64.dll"
  IfFileExists "$0" ndi_copy 0

  IfFileExists "$PROGRAMFILES\NDI\NDI 6 Runtime\v6\Processing.NDI.Lib.x64.dll" 0 +2
    StrCpy $0 "$PROGRAMFILES\NDI\NDI 6 Runtime\v6\Processing.NDI.Lib.x64.dll"
  IfFileExists "$0" ndi_copy 0

  IfFileExists "$PROGRAMFILES\NDI\NDI 6 Runtime\Processing.NDI.Lib.x64.dll" 0 +2
    StrCpy $0 "$PROGRAMFILES\NDI\NDI 6 Runtime\Processing.NDI.Lib.x64.dll"
  IfFileExists "$0" ndi_copy 0

  DetailPrint "NDI runtime DLL not found in common NDI 6 install paths."
  Goto ndi_copy_done

ndi_copy:
  ; Copy to classic build output location if present.
  IfFileExists "$INSTDIR\resources\app.asar.unpacked\node_modules\grandiose\build\Release\grandiose.node" 0 +2
    CopyFiles /SILENT "$0" "$INSTDIR\resources\app.asar.unpacked\node_modules\grandiose\build\Release\Processing.NDI.Lib.x64.dll"

  ; Copy to all ABI-specific folders (win32-x64-*) so Electron ABI bumps are covered.
  nsExec::ExecToLog 'cmd /c for /d %D in ("$INSTDIR\resources\app.asar.unpacked\node_modules\grandiose\bin\win32-x64-*") do if exist "%D\grandiose.node" copy /Y "$0" "%D\Processing.NDI.Lib.x64.dll"'

  DetailPrint "Copied NDI runtime DLL from $0"

ndi_copy_done:
!macroend

!macro customUnInstall
  ; Clean up firewall rules when uninstalling
  nsExec::ExecToLog '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="ScriptureFlow NDI"'
!macroend

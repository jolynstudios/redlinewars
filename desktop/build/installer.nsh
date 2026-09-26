; Redline Wars NSIS include (T3.13 item 4): the LAN game needs an inbound
; firewall allow rule for the game executable; the uninstaller removes it.
!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Redline Wars (LAN games)" dir=in action=allow program="$INSTDIR\Redline Wars.exe" profile=private,domain'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Redline Wars (LAN games)"'
!macroend

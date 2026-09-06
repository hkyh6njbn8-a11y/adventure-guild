' watchdog-check.vbs - hidden wrapper for watchdog-check.ps1 (opt-017)
' Scheduled task runs wscript.exe -> no console flash (GUI subsystem).
' wscript hides the powershell console window entirely.
Set sh = CreateObject("WScript.Shell")
' APP_DIR: D:\冒险公会 - build via ChrW so file stays ASCII-safe in any codepage
appDir = "D:\" & ChrW(&H5192) & ChrW(&H9669) & ChrW(&H516C) & ChrW(&H4F1A)
ps1 = appDir & "\watchdog-check.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
' 0 = hidden window, False = don't wait
sh.Run cmd, 0, False

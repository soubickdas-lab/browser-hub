' Launches the Browser Hub dashboard minimized to the system tray (no window
' pop-up on login). Click the tray icon any time to open it.
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\CLAUDE CHAT\browser-hub\ui"
WshShell.Run "cmd /c ""node_modules\.bin\electron.cmd"" . --hidden", 0, False

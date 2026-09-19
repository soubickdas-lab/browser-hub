' Launches local-hub.js with no visible console window.
' Used by the "BrowserHub" scheduled task so the hub survives logins,
' Claude restarts, and closed windows — always the same port, always up.
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\CLAUDE CHAT\browser-hub"
WshShell.Run "node ""D:\CLAUDE CHAT\browser-hub\local-hub.js""", 0, False

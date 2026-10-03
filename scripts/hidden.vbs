' Run a .cmd without a console window (used by the Task Scheduler jobs). usage: wscript hidden.vbs <file.cmd>
CreateObject("WScript.Shell").Run """" & WScript.Arguments(0) & """", 0, True

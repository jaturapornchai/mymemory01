@echo off
rem memory-hub hourly: archive+index new sessions/notes, then republish the anonymized brain if it changed
cd /d "%~dp0.."
if not exist logs mkdir logs
echo === %date% %time% >> logs\hourly.log
"C:\Program Files\nodejs\node.exe" src\cli.ts sync >> logs\hourly.log 2>&1
"C:\Program Files\nodejs\node.exe" src\cli.ts publish >> logs\hourly.log 2>&1

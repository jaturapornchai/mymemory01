@echo off
rem memory-hub hourly: archive+index new sessions/notes, then republish the anonymized brain if it changed
cd /d "%~dp0.."
if not exist logs mkdir logs
echo === %date% %time% >> logs\hourly.log
curl -fsS --max-time 1 http://127.0.0.1:11434/api/ps >nul 2>nul || start "" /b ollama serve >nul 2>nul
rem schema first (idempotent: IF NOT EXISTS only), so new code never runs on an old schema: a failed migrate skips this hour
"C:\Program Files\nodejs\node.exe" --no-warnings src\cli.ts migrate >> logs\hourly.log 2>&1 || exit /b 1
"C:\Program Files\nodejs\node.exe" --no-warnings src\cli.ts sync >> logs\hourly.log 2>&1
if exist deploy\memory-hub-brain\.vercel "C:\Program Files\nodejs\node.exe" --no-warnings src\cli.ts publish >> logs\hourly.log 2>&1

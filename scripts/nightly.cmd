@echo off
rem memory-hub nightly: dream (Claude only; fails safely if the CLI is not logged in to Anthropic), consolidation, publish
cd /d "%~dp0.."
if not exist logs mkdir logs
echo === %date% %time% >> logs\nightly.log
"C:\Program Files\nodejs\node.exe" src\cli.ts dream >> logs\nightly.log 2>&1
"C:\Program Files\nodejs\node.exe" src\cli.ts dream --consolidate >> logs\nightly.log 2>&1
"C:\Program Files\nodejs\node.exe" src\cli.ts publish >> logs\nightly.log 2>&1

@echo off
rem memory-hub nightly: dream (Claude only; fails safely if the CLI is not logged in to Anthropic), consolidation, yesterday's daily note (after the dream so its sessions have cards; no LLM, a failure only logs), lint, publish
cd /d "%~dp0.."
if not exist logs mkdir logs
echo === %date% %time% >> logs\nightly.log
"C:\Program Files\nodejs\node.exe" src\cli.ts dream >> logs\nightly.log 2>&1
"C:\Program Files\nodejs\node.exe" src\cli.ts dream --consolidate >> logs\nightly.log 2>&1
"C:\Program Files\nodejs\node.exe" src\cli.ts daily >> logs\nightly.log 2>&1
rem lint = report-only checks written to hubs\_lint.md in the memory vault; a failure is logged and the job goes on
"C:\Program Files\nodejs\node.exe" src\cli.ts lint >> logs\nightly.log 2>&1 || echo lint failed >> logs\nightly.log
"C:\Program Files\nodejs\node.exe" src\cli.ts publish >> logs\nightly.log 2>&1

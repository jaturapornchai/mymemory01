@echo off
rem memory-hub nightly: dream (DeepSeek off-peak by default; cli skips peak hours and scrubs key-shaped tokens), consolidation, yesterday's daily note (after the dream so its sessions have cards; no LLM, a failure only logs), lint, publish, sem
cd /d "%~dp0.."
if not exist logs mkdir logs
echo === %date% %time% >> logs\nightly.log
"C:\Program Files\nodejs\node.exe" src\cli.ts dream >> logs\nightly.log 2>&1
"C:\Program Files\nodejs\node.exe" src\cli.ts dream --consolidate >> logs\nightly.log 2>&1
"C:\Program Files\nodejs\node.exe" src\cli.ts daily >> logs\nightly.log 2>&1
rem lint --fix = auto-retire machine dups/expired/replaced, then write report to hubs\_lint.md; a failure is logged and the job goes on
"C:\Program Files\nodejs\node.exe" src\cli.ts lint --fix >> logs\nightly.log 2>&1 || echo lint failed >> logs\nightly.log
"C:\Program Files\nodejs\node.exe" src\cli.ts publish >> logs\nightly.log 2>&1
rem sem = the local Gemma (llama-server :8080) judges new top-cosine pairs into synapses of kind sem; skipped when it is not up
"C:\Program Files\nodejs\node.exe" src\cli.ts sem >> logs\nightly.log 2>&1

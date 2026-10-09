# memory-hub scheduled jobs (current user, only while logged on, no stored password, hidden window).
#   install:   powershell -ExecutionPolicy Bypass -File scripts\install-tasks.ps1
#   uninstall: powershell -ExecutionPolicy Bypass -File scripts\install-tasks.ps1 -Remove
param([switch]$Remove)
$folder = '\memory-hub\'
$root = Split-Path -Parent $PSScriptRoot # the repo folder, wherever it is cloned
if ($Remove) {
  Unregister-ScheduledTask -TaskPath $folder -TaskName hourly -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskPath $folder -TaskName nightly -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskPath $folder -TaskName serve -Confirm:$false -ErrorAction SilentlyContinue
  'removed'; exit
}
$vbs = Join-Path $root 'scripts\hidden.vbs'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(17) -RepetitionInterval (New-TimeSpan -Hours 1)
$nightly = New-ScheduledTaskTrigger -Daily -At '03:30'
foreach ($t in @(@{ n = 'hourly'; tr = $hourly }, @{ n = 'nightly'; tr = $nightly })) {
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`" `"$root\scripts\$($t.n).cmd`"" -WorkingDirectory $root
  Register-ScheduledTask -TaskPath $folder -TaskName $t.n -Action $action -Trigger $t.tr -Settings $settings `
    -Description "memory-hub $($t.n) job ($root\scripts\$($t.n).cmd)" -Force | Out-Null
}
# optional, machine-specific: scripts\serve.cmd (web monitor + MCP online), runs from logon until logoff, no time limit
if (Test-Path "$root\scripts\serve.cmd") {
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`" `"$root\scripts\serve.cmd`"" -WorkingDirectory $root
  $serve = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskPath $folder -TaskName serve -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) `
    -Settings $serve -Description "memory-hub online ($root\scripts\serve.cmd)" -Force | Out-Null
}
Get-ScheduledTask -TaskPath $folder | Select-Object TaskName, State, @{ n = 'Next'; e = { ($_ | Get-ScheduledTaskInfo).NextRunTime } }

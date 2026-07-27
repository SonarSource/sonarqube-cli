# Native Windows toast notification helper for SonarQube CLI.
#
# Mirrors the macOS notifier (notifier.swift) as closely as PowerShell allows:
#
#   runInTerminal()      → Invoke-InTerminal
#   NotificationDelegate → add_Activated / add_Dismissed on the toast object
#   RunLoop (60 s)       → WaitHandle.WaitAny with a 60-second timeout
#   exit(0) on click     → exit 0 after Invoke-InTerminal
#
# Windows-only addition: when the script is invoked as SYSTEM (e.g. from an
# MDM policy or service), it detects the active console user and re-launches
# itself in that user's interactive session via a one-shot scheduled task —
# because WinRT toast notifications are per-desktop-session and SYSTEM has none.
#
# Usage: notifier.ps1 <title> <message> [command-to-run-in-terminal]

param(
    # MDM push commands (e.g. JumpCloud) run this script with no arguments —
    # defaults match the macOS notifier's hardcoded TITLE/MESSAGE/COMMAND.
    [Parameter(Position = 0)] [string] $Title   = 'SonarQube CLI installed',
    [Parameter(Position = 1)] [string] $Message = 'Click to run: sonar auth login',
    [Parameter(Position = 2)] [string] $Command = 'sonar auth login'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Invoke-InTerminal ─────────────────────────────────────────────────────────
# Mirrors runInTerminal(_ command: String?) in notifier.swift.
# With a command: opens a new terminal window and runs it.
# Without a command: just opens a terminal window (activates it).
# Prefers Windows Terminal (wt.exe); falls back to cmd.exe.

function Invoke-InTerminal([string] $Cmd) {
    $wt = Get-Command wt.exe -ErrorAction SilentlyContinue
    if ($Cmd -ne '') {
        $escaped = $Cmd -replace '"', '\"'
        if ($wt) {
            Start-Process wt.exe -ArgumentList "new-window -- powershell.exe -NoExit -Command `"$escaped`""
        } else {
            Start-Process cmd.exe -ArgumentList "/K `"$escaped`""
        }
    } else {
        if ($wt) { Start-Process wt.exe } else { Start-Process cmd.exe }
    }
}

# ── SYSTEM → interactive-user hand-off (Windows-specific) ────────────────────
# SYSTEM has no desktop session; WinRT toasts are per-session.
# Re-launch this script as the active console user via a one-shot scheduled
# task with LogonType=Interactive — no third-party binaries required.

function Get-ActiveConsoleUser {
    # Parses `quser` output to find the Active session.
    # Returns [pscustomobject]@{ Full; SessionId } or $null.
    #
    # quser column layout (fixed-width, header on first line):
    #   USERNAME         SESSIONNAME     ID  STATE   IDLE TIME  LOGON TIME
    #  >alice            console          1  Active      none   23/07/2026 ...
    $lines = & quser 2>$null
    if (-not $lines) { return $null }
    foreach ($line in ($lines | Select-Object -Skip 1)) {
        $line = $line -replace '^\s*>', ' '
        if ($line -match '^\s+(\S+)\s+\S+\s+(\d+)\s+Active') {
            $username  = $Matches[1]
            $sessionId = [int] $Matches[2]
            $logon = Get-CimInstance Win32_LoggedOnUser -ErrorAction SilentlyContinue |
                     Where-Object { $_.Dependent.Name -eq $username } |
                     Select-Object -First 1
            $domain = if ($logon) { $logon.Antecedent.Domain } else { $env:COMPUTERNAME }
            return [pscustomobject]@{ Full = "$domain\$username"; SessionId = $sessionId }
        }
    }
    return $null
}

if ([Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) {
    $user = Get-ActiveConsoleUser
    if ($null -eq $user) {
        Write-Error 'No active console user found; cannot deliver notification.'
        exit 1
    }

    # MDM agents (e.g. JumpCloud) typically delete their generated temp script
    # right after this process exits — copy it to a stable path first so the
    # scheduled task below still finds it ~5s later when its trigger fires.
    $stableScript = Join-Path $env:ProgramData 'SonarSource\sonarqube-cli\notifier.ps1'
    New-Item -ItemType Directory -Path (Split-Path $stableScript) -Force | Out-Null
    Copy-Item -Path $PSCommandPath -Destination $stableScript -Force

    # -WindowStyle Hidden means a failure here is otherwise invisible (no
    # console, no Action Center entry) — log any terminating error so a
    # future failure leaves a trail instead of a silent flash-and-vanish.
    $logPath = Join-Path (Split-Path $stableScript) 'notifier.log'
    $relaunch = "try { & '$($stableScript -replace "'", "''"  )'" +
                " -Title   '$($Title   -replace "'", "''" )'" +
                " -Message '$($Message -replace "'", "''" )'" +
                " -Command '$($Command -replace "'", "''" )'" +
                " } catch { `$_ | Out-File -FilePath '$($logPath -replace "'", "''")' -Append }"
    # Base64-encode the re-launch so special characters in the arguments
    # survive the Task Scheduler → powershell.exe argument wall unharmed.
    $encoded  = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($relaunch))

    $taskName  = "SonarNotifier_$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    $action    = New-ScheduledTaskAction `
                     -Execute  'powershell.exe' `
                     -Argument "-NonInteractive -WindowStyle Hidden -EncodedCommand $encoded"
    $principal = New-ScheduledTaskPrincipal `
                     -UserId    $user.Full `
                     -LogonType Interactive `
                     -RunLevel  Limited
    $settings  = New-ScheduledTaskSettingsSet `
                     -StartWhenAvailable `
                     -ExecutionTimeLimit     (New-TimeSpan -Minutes 2) `
                     -DeleteExpiredTaskAfter (New-TimeSpan -Seconds 30)
    $trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5)
    # DeleteExpiredTaskAfter (below) requires the trigger to declare when it
    # "expires" — New-ScheduledTaskTrigger -Once leaves EndBoundary unset,
    # which Register-ScheduledTask then rejects as malformed XML.
    $trigger.EndBoundary = (Get-Date).AddMinutes(2).ToString('yyyy-MM-ddTHH:mm:ss')

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName

    Start-Sleep -Seconds 5
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    exit 0
}

# ── Toast notification (interactive user context) ─────────────────────────────
# Mirrors the UNUserNotificationCenter setup in notifier.swift.
#
# In-process ToastNotification.Activated only fires when the AUMID has a
# registered COM activator — which PowerShell's built-in AUMID does not have.
# Instead we register a one-shot URI scheme in HKCU: the toast uses
# activationType="protocol", so Windows routes the click directly to our
# registered handler without any COM machinery.
# Mirrors runInTerminal() being called from didReceive.

# Load WinRT types — Windows PowerShell 5.1 on Windows 10 / 11.
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.ToastNotification,        Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument,                  Windows.Data.Xml.Dom,     ContentType = WindowsRuntime]

# PowerShell's own AUMID — already registered in the Start menu, so Windows
# delivers toasts without any extra COM / app registration.
# Mirrors the CFBundleIdentifier in SonarNotifier.app/Contents/Info.plist.
$AppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

# ── Register a one-shot URI scheme in HKCU ───────────────────────────────────
# Unique scheme per invocation so concurrent notifications don't collide.
# HKCU\SOFTWARE\Classes requires no elevation.
$schemeId = "sonarnotify$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$regBase  = "HKCU:\SOFTWARE\Classes\$schemeId"

# Build the handler registered in the URI scheme.
#
# For commands: use cmd.exe /K so keystrokes reach the child process unchanged.
# powershell.exe -Command intercepts raw/VT input, which breaks Node.js
# interactive prompts (arrow-key menus like `sonar auth login`).
# cmd.exe /K passes stdin straight through to the child — no PS input layer.
$safeForCmd = $Command -replace '"', '\"'
$openCmd = if ($Command -ne '') {
    "Start-Process cmd.exe -ArgumentList '/K $safeForCmd' -WindowStyle Normal"
} else {
    'Start-Process cmd.exe -WindowStyle Normal'
}
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($openCmd))
$handler = "powershell.exe -WindowStyle Hidden -NonInteractive -EncodedCommand $encoded"

New-Item -Path "$regBase\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $regBase                      -Name '(default)'    -Value 'SonarQube Notification'
Set-ItemProperty -Path $regBase                      -Name 'URL Protocol' -Value ''
Set-ItemProperty -Path "$regBase\shell\open\command" -Name '(default)'    -Value $handler

# ── Build and show toast ──────────────────────────────────────────────────────
# activationType="protocol" → click fires the URI scheme handler above.
# Whole banner is the click target (no <actions> block), same as macOS.
# <audio> mirrors content.sound = .default.
$xdoc = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xdoc.LoadXml(@"
<toast activationType="protocol" launch="${schemeId}:open" duration="long">
  <visual>
    <binding template="ToastGeneric">
      <text>$([System.Security.SecurityElement]::Escape($Title))</text>
      <text>$([System.Security.SecurityElement]::Escape($Message))</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Default"/>
</toast>
"@)

$toast = [Windows.UI.Notifications.ToastNotification]::new($xdoc)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)

# ── RunLoop equivalent ────────────────────────────────────────────────────────
# Mirrors RunLoop.main.run(until: Date().addingTimeInterval(60)).
# Keep the process alive so the URI scheme remains registered while the toast
# is visible; clean up afterward.
Start-Sleep -Seconds 60
Remove-Item -Path $regBase -Recurse -Force -ErrorAction SilentlyContinue

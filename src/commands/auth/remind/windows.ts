/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

import { randomUUID } from 'node:crypto';

import { spawnProcess } from '@/core/process/process.ts';

import {
  type LoginReminder,
  NOTIFICATION_TIMEOUT_SECONDS,
  type ReminderNotifier,
  runWithInheritedOutput,
} from './shared.ts';

const SYSTEM_ACCOUNT = String.raw`nt authority\system`;
const POWERSHELL_APP_ID = String.raw`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`;
const HAND_OFF_LOG_DIRECTORY = String.raw`SonarSource\sonarqube-cli`;

export function createWindowsNotifier(): ReminderNotifier {
  return {
    async isElevated() {
      const { stdout } = await spawnProcess('whoami', []);
      return stdout.toLowerCase() === SYSTEM_ACCOUNT;
    },

    handOffToConsoleUser: (argv) => runPowerShell(buildHandOffScript(argv)),

    notify: (reminder) => runPowerShell(buildToastScript(reminder)),
  };
}

/**
 * SYSTEM has no desktop session and WinRT toasts are per session, so the CLI is relaunched as the
 * active console user through a one-shot scheduled task with an interactive logon.
 */
function buildHandOffScript(argv: string[]): string {
  const logDirectory = `(Join-Path $env:ProgramData ${psQuote(HAND_OFF_LOG_DIRECTORY)})`;
  const relaunch = `& ${argv.map(psQuote).join(' ')} *>> (Join-Path ${logDirectory} 'notifier.log')`;
  return String.raw`
$ErrorActionPreference = 'Stop'

function Get-ActiveConsoleUser {
    $lines = & quser 2>$null
    if (-not $lines) { return $null }
    foreach ($line in ($lines | Select-Object -Skip 1)) {
        $line = $line -replace '^\s*>', ' '
        if ($line -match '^\s+(\S+)\s+\S+\s+(\d+)\s+Active') {
            $username = $Matches[1]
            $logon = Get-CimInstance Win32_LoggedOnUser -ErrorAction SilentlyContinue |
                     Where-Object { $_.Dependent.Name -eq $username } |
                     Select-Object -First 1
            $domain = if ($logon) { $logon.Antecedent.Domain } else { $env:COMPUTERNAME }
            return "$domain\$username"
        }
    }
    return $null
}

$user = Get-ActiveConsoleUser
if ($null -eq $user) {
    Write-Error 'No active console user found; cannot deliver notification.'
    exit 1
}

New-Item -ItemType Directory -Path ${logDirectory} -Force | Out-Null
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(${psQuote(relaunch)}))
$taskName = "SonarNotifier_$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NonInteractive -WindowStyle Hidden -EncodedCommand $encoded"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -DeleteExpiredTaskAfter (New-TimeSpan -Seconds 30)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5)
$trigger.EndBoundary = (Get-Date).AddMinutes(2).ToString('yyyy-MM-ddTHH:mm:ss')

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 5
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
`;
}

/**
 * The toast is activated by protocol: a one-shot URI scheme in HKCU is mapped to a handler that opens
 * a terminal, so the click works without any COM activator and needs no process to stay registered
 * beyond the toast's lifetime.
 */
function buildToastScript(reminder: LoginReminder): string {
  const scheme = `sonarnotify${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const loginCommandLine = reminder.loginArgv.map((arg) => `"${arg}"`).join(' ');
  const terminalArguments = `/K "${loginCommandLine}"`;
  const openTerminal = `Start-Process cmd.exe -ArgumentList ${psQuote(terminalArguments)} -WindowStyle Normal`;
  const handler = `powershell.exe -WindowStyle Hidden -NonInteractive -EncodedCommand ${encodePowerShell(openTerminal)}`;
  const toastXml = `<toast activationType="protocol" launch="${scheme}:open" duration="long">
  <visual>
    <binding template="ToastGeneric">
      <text>${escapeXml(reminder.title)}</text>
      <text>${escapeXml(reminder.message)}</text>
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Default"/>
</toast>`;
  return String.raw`
$ErrorActionPreference = 'Stop'
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]

$scheme = ${psQuote(scheme)}
$registryPath = "HKCU:\SOFTWARE\Classes\$scheme"
try {
    New-Item -Path "$registryPath\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path $registryPath -Name '(default)' -Value 'SonarQube Notification'
    Set-ItemProperty -Path $registryPath -Name 'URL Protocol' -Value ''
    Set-ItemProperty -Path "$registryPath\shell\open\command" -Name '(default)' -Value ${psQuote(handler)}

    $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
    $xml.LoadXml(${psQuote(toastXml)})
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(POWERSHELL_APP_ID)}).Show($toast)
    Start-Sleep -Seconds ${NOTIFICATION_TIMEOUT_SECONDS}
} finally {
    Remove-Item -Path $registryPath -Recurse -Force -ErrorAction SilentlyContinue
}
`;
}

function runPowerShell(script: string): Promise<void> {
  return runWithInheritedOutput('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodePowerShell(script),
  ]);
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

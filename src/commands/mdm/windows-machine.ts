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

import { windowsPowerShellPath } from '@/core/host/environment/platform-detector.ts';
import { spawnProcess } from '@/core/process/process.ts';

const DIRECTORY_ENV = 'SONAR_MDM_DIRECTORY';

const BROADCAST_ENVIRONMENT_CHANGE_SCRIPT = `
$sig = '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
Add-Type -MemberDefinition $sig -Name 'Win32SendMsg' -Namespace 'NativeMethods' -ErrorAction SilentlyContinue
$result = [UIntPtr]::Zero
[NativeMethods.Win32SendMsg]::SendMessageTimeout([IntPtr]0xFFFF, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
`;

const ADD_TO_MACHINE_PATH_SCRIPT = `
$dir = $env:${DIRECTORY_ENV}
$current = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if (($current -split ';') -contains $dir) { exit 0 }
[Environment]::SetEnvironmentVariable('Path', $current.TrimEnd(';') + ';' + $dir, 'Machine')
${BROADCAST_ENVIRONMENT_CHANGE_SCRIPT}`;

const REMOVE_FROM_MACHINE_PATH_SCRIPT = String.raw`
$dir = $env:${DIRECTORY_ENV}
$current = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$entries = @($current -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $dir.TrimEnd('\')) })
if ($entries.Count -eq @($current -split ';' | Where-Object { $_ }).Count) { exit 0 }
[Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'Machine')
${BROADCAST_ENVIRONMENT_CHANGE_SCRIPT}`;

export async function grantReadExecuteToAllUsers(path: string): Promise<void> {
  const result = await spawnProcess('icacls', [path, '/grant', 'Authenticated Users:(RX)']);
  if (result.exitCode !== 0) {
    throw new Error(`icacls failed with exit code ${String(result.exitCode)}: ${result.stderr}`);
  }
}

async function runMachinePathScript(script: string, directory: string): Promise<void> {
  const result = await spawnProcess(
    windowsPowerShellPath(),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { [DIRECTORY_ENV]: directory } },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Updating the machine PATH failed with exit code ${String(result.exitCode)}: ${result.stderr}`,
    );
  }
}

export function addToMachinePath(directory: string): Promise<void> {
  return runMachinePathScript(ADD_TO_MACHINE_PATH_SCRIPT, directory);
}

export function removeFromMachinePath(directory: string): Promise<void> {
  return runMachinePathScript(REMOVE_FROM_MACHINE_PATH_SCRIPT, directory);
}

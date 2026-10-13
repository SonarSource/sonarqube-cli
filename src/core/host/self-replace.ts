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

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { isWindows, windowsPowerShellPath } from '@/core/host/environment/platform-detector.ts';
import { spawnProcess } from '@/core/process/process.ts';

const DELETE_TARGET_ENV = 'SONAR_SELF_REPLACE_DELETE_TARGET';
const MOVEFILE_DELAY_UNTIL_REBOOT = 4;
export const EXECUTABLE_MODE = 0o755;

const DELETE_ON_REBOOT_SCRIPT = `
$sig = '[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool MoveFileEx(string existingFileName, string newFileName, int flags);'
Add-Type -MemberDefinition $sig -Name 'Win32MoveFile' -Namespace 'NativeMethods'
if (-not [NativeMethods.Win32MoveFile]::MoveFileEx($env:${DELETE_TARGET_ENV}, $null, ${MOVEFILE_DELAY_UNTIL_REBOOT})) {
  exit [Runtime.InteropServices.Marshal]::GetLastWin32Error()
}
`;

function asideSuffix(): string {
  return `.${Date.now()}.old`;
}

function removeStaleAsideFiles(target: string): void {
  if (!existsSync(dirname(target))) {
    return;
  }
  const prefix = `${basename(target)}.`;
  for (const name of readdirSync(dirname(target))) {
    if (name.startsWith(prefix) && name.endsWith('.old')) {
      try {
        rmSync(join(dirname(target), name), { force: true });
      } catch {
        continue;
      }
    }
  }
}

async function deleteOnReboot(path: string): Promise<void> {
  const result = await spawnProcess(
    windowsPowerShellPath(),
    ['-NoProfile', '-NonInteractive', '-Command', DELETE_ON_REBOOT_SCRIPT],
    { env: { [DELETE_TARGET_ENV]: path } },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Scheduling ${path} for deletion failed with exit code ${String(result.exitCode)}: ${result.stderr}`,
    );
  }
}

export async function replaceBinary(sourcePath: string, targetPath: string): Promise<void> {
  mkdirSync(dirname(targetPath), { recursive: true });
  const incomingPath = `${targetPath}.new`;
  rmSync(incomingPath, { force: true });
  copyFileSync(sourcePath, incomingPath);
  chmodSync(incomingPath, EXECUTABLE_MODE);

  if (!isWindows()) {
    renameSync(incomingPath, targetPath);
    return;
  }

  removeStaleAsideFiles(targetPath);
  const asidePath = `${targetPath}${asideSuffix()}`;
  const hadPrevious = existsSync(targetPath);
  if (hadPrevious) {
    renameSync(targetPath, asidePath);
  }
  try {
    renameSync(incomingPath, targetPath);
  } catch (error) {
    if (hadPrevious) {
      renameSync(asidePath, targetPath);
    }
    throw error;
  }
  if (hadPrevious) {
    await deleteOnReboot(asidePath);
  }
}

export async function removeBinary(targetPath: string): Promise<void> {
  if (isWindows()) {
    removeStaleAsideFiles(targetPath);
  }
  try {
    rmSync(targetPath, { force: true });
    return;
  } catch (error) {
    if (!isWindows()) {
      throw error;
    }
  }
  const asidePath = `${targetPath}${asideSuffix()}`;
  renameSync(targetPath, asidePath);
  await deleteOnReboot(asidePath);
}

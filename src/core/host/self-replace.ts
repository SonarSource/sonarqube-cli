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
const PARENT_PID_ENV = 'SONAR_SELF_REPLACE_PARENT_PID';
const MOVEFILE_DELAY_UNTIL_REBOOT = 4;
const HELPER_RETRY_COUNT = 120;
const HELPER_RETRY_DELAY_MS = 500;
export const EXECUTABLE_MODE = 0o755;

const DELETE_HELPER_SCRIPT = `
Wait-Process -Id $env:${PARENT_PID_ENV} -ErrorAction SilentlyContinue
for ($i = 0; $i -lt ${HELPER_RETRY_COUNT} -and (Test-Path -LiteralPath $env:${DELETE_TARGET_ENV}); $i++) {
  try { Remove-Item -LiteralPath $env:${DELETE_TARGET_ENV} -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds ${HELPER_RETRY_DELAY_MS} }
}
`;

function deleteAfterExitLauncherScript(): string {
  const helper = Buffer.from(DELETE_HELPER_SCRIPT, 'utf16le').toString('base64');
  return `
Add-Type -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool MoveFileEx(string existingFileName, string newFileName, int flags);' -Name 'Win32MoveFile' -Namespace 'NativeMethods'
[NativeMethods.Win32MoveFile]::MoveFileEx($env:${DELETE_TARGET_ENV}, [NullString]::Value, ${MOVEFILE_DELAY_UNTIL_REBOOT}) | Out-Null
Start-Process -FilePath '${windowsPowerShellPath()}' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${helper}' -WindowStyle Hidden
`;
}

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

async function discardAside(path: string): Promise<void> {
  try {
    rmSync(path);
    return;
  } catch {
    // the aside is still locked by the running binary: hand it to the helper
  }
  try {
    await spawnProcess(
      windowsPowerShellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', deleteAfterExitLauncherScript()],
      { env: { [DELETE_TARGET_ENV]: path, [PARENT_PID_ENV]: String(process.pid) } },
    );
  } catch {
    return;
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
    await discardAside(asidePath);
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
  await discardAside(asidePath);
}

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

import { spawn } from 'node:child_process';
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

const DELETE_TARGET_ENV = 'SONAR_SELF_REPLACE_DELETE_TARGET';
export const EXECUTABLE_MODE = 0o755;

function asideSuffix(): string {
  return `.${Date.now()}.old`;
}

function removeStaleAsideFiles(target: string): void {
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

function deleteAfterExit(path: string): void {
  const script =
    `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue; ` +
    `for ($i = 0; $i -lt 30 -and (Test-Path -LiteralPath $env:${DELETE_TARGET_ENV}); $i++) { ` +
    `Remove-Item -LiteralPath $env:${DELETE_TARGET_ENV} -Force -ErrorAction SilentlyContinue; ` +
    `if (Test-Path -LiteralPath $env:${DELETE_TARGET_ENV}) { Start-Sleep -Seconds 1 } }`;
  spawn(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      SystemRoot: process.env.SystemRoot ?? String.raw`C:\Windows`,
      ...process.env,
      [DELETE_TARGET_ENV]: path,
    },
  }).unref();
}

export function replaceBinary(sourcePath: string, targetPath: string): void {
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
    deleteAfterExit(asidePath);
  }
}

export function removeBinary(targetPath: string): void {
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
  deleteAfterExit(asidePath);
}

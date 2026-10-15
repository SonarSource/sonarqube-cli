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

import { realpathSync } from 'node:fs';
import { join, normalize, sep, win32 } from 'node:path';

import { isWindows } from '@/core/host/environment/platform-detector.ts';

export const HOMEBREW_UPDATE_GUIDANCE = 'Run brew upgrade sonarqube-cli to update it.';

export const EXTERNAL_UPDATE_GUIDANCE =
  'Update it through your organization, package manager, or the method used to install it.';

function canonicalPath(path: string, windows: boolean): string {
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync.native(path);
  } catch {
    resolvedPath = path;
  }
  return windows ? win32.normalize(resolvedPath).toLowerCase() : normalize(resolvedPath);
}

export function isHomebrewInstallation(): boolean {
  if (isWindows()) return false;
  const executablePath = canonicalPath(process.execPath, false).split(sep).join('/');
  return /\/Caskroom\/sonarqube-cli\/[^/]+\/[^/]+$/.test(executablePath);
}

export function externalUpdateGuidance(): string {
  return isHomebrewInstallation() ? HOMEBREW_UPDATE_GUIDANCE : EXTERNAL_UPDATE_GUIDANCE;
}

export function isStandaloneInstallerLocation(): boolean {
  const windows = isWindows();
  let expectedPath: string | undefined;
  let executablePath: string;

  if (windows) {
    const installRoot = process.env.LOCALAPPDATA;
    expectedPath = installRoot
      ? win32.join(
          canonicalPath(win32.join(installRoot, 'sonarqube-cli', 'bin'), true),
          'sonar.exe',
        )
      : undefined;
    executablePath = canonicalPath(process.execPath, true);
  } else {
    const installRoot = process.env.HOME;
    expectedPath = installRoot
      ? join(
          canonicalPath(join(installRoot, '.local', 'share', 'sonarqube-cli', 'bin'), false),
          'sonar',
        )
      : undefined;
    executablePath = canonicalPath(process.execPath, false);
  }

  return executablePath === expectedPath;
}

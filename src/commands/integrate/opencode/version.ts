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

import { spawnProcessWithTimeout } from '@/core/process/process.ts';

const VERSION_TIMEOUT_MS = 5000;
const VERSION_PATTERN = /(?:^|\s)v?(\d+\.\d+\.\d+)/m;

const FIRST_SUPPORTED_MAJOR_VERSION = 2;

export async function detectLegacyOpenCodeVersion(): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await spawnProcessWithTimeout(
      'opencode',
      ['--version'],
      { stdin: 'ignore' },
      VERSION_TIMEOUT_MS,
      'opencode --version timed out',
    );
    const version = VERSION_PATTERN.exec(stdout)?.[1];
    const isLegacy =
      version !== undefined && Number(version.split('.')[0]) < FIRST_SUPPORTED_MAJOR_VERSION;
    return exitCode === 0 && isLegacy ? version : undefined;
  } catch {
    return undefined;
  }
}

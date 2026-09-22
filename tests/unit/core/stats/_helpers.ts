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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'bun:test';

import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';

import { restoreEnv } from '../../../_common/isolated-cli-env.ts';

const IS_WINDOWS = process.platform === 'win32';

/** Points ENV_SONAR_USER_HOME at a fresh temp dir for each test in the calling file, and cleans it up after. */
export function useTempSonarUserHome(prefix: string): void {
  let testSonarUserHome: string;
  const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];

  beforeEach(async () => {
    testSonarUserHome = await mkdtemp(join(tmpdir(), prefix));
    process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;
  });

  afterEach(async () => {
    // Windows can hold the just-closed db's WAL/SHM handles past our retries; best-effort
    // only — the OS reclaims the temp dir regardless, same as tests/integration/harness/index.ts.
    await rm(testSonarUserHome, {
      recursive: true,
      force: true,
      maxRetries: IS_WINDOWS ? 15 : 5,
      retryDelay: IS_WINDOWS ? 200 : 100,
    }).catch(() => {});
    restoreEnv(ENV_SONAR_USER_HOME, previousSonarUserHome);
  });
}

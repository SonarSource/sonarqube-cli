/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Integration tests for `sonar hook agent-session-start`.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'bun:test';

import { withAgentInstallLock } from '@/commands/integrate/_common/agent-install-lock.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';

import { ISOLATED_CLI_SPAWN_ENV, restoreEnv } from '../../../../_common/isolated-cli-env.ts';

it('rejects overlapping installs and releases the lock when its owner exits', async () => {
  const previousHome = process.env[ENV_SONAR_USER_HOME];
  const home = mkdtempSync(join(tmpdir(), 'sonar-agent-lock-'));
  process.env[ENV_SONAR_USER_HOME] = home;
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
      import { withAgentInstallLock } from './src/commands/integrate/_common/agent-install-lock.ts';
      await withAgentInstallLock(() => {
        process.stdout.write('locked');
        return Bun.sleep(60_000);
      });
    `,
    ],
    {
      env: { ...process.env, ...ISOLATED_CLI_SPAWN_ENV },
      stdout: 'pipe',
    },
  );
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('locked');
    const rejected = await withAgentInstallLock(() => true).catch((error: unknown) => error);
    expect(rejected).toEqual(
      expect.objectContaining({ message: expect.stringContaining('Retry setup shortly') }),
    );

    child.kill();
    await child.exited;
    expect(await withAgentInstallLock(() => true)).toBe(true);
  } finally {
    child.kill();
    await child.exited;
    restoreEnv(ENV_SONAR_USER_HOME, previousHome);
    rmSync(home, { recursive: true, force: true });
  }
});

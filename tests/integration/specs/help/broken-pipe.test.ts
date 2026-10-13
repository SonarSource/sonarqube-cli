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
import { once } from 'node:events';

import { expect, it } from 'bun:test';

import { ISOLATED_CLI_SPAWN_ENV } from '../../../_common/isolated-cli-env.ts';
import { getCliBinaryPath } from '../../harness/cli-runner.ts';

const cliEnv = {
  ...process.env,
  ...ISOLATED_CLI_SPAWN_ENV,
  SONARQUBE_CLI_TOKEN: 'placeholder',
  SONARQUBE_CLI_ORG: 'example',
};

it.skipIf(process.platform === 'win32')('does not crash when stdout closes early', async () => {
  // The reader exits before the CLI starts, so the CLI's first stdout write hits a broken pipe.
  const child = spawn('sh', ['-c', '{ sleep 0.5; "$0" config list; } | true', getCliBinaryPath()], {
    env: cliEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  await once(child, 'close');

  expect(stderr).not.toContain('EPIPE');
});

it('does not crash when stderr closes early', async () => {
  const child = spawn(getCliBinaryPath(), ['analyze', 'secrets'], {
    env: cliEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stderr.destroy();
  const [code] = await once(child, 'close');

  expect(code).toBe(2);
});

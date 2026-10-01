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

it.each([
  { args: ['--help'], stream: 'stdout', exitCode: 0 },
  { args: ['analyze', 'secrets'], stream: 'stderr', exitCode: 2 },
] as const)('does not crash when $stream closes early', async ({ args, stream, exitCode }) => {
  const child = spawn(getCliBinaryPath(), args, {
    env: {
      ...process.env,
      ...ISOLATED_CLI_SPAWN_ENV,
      SONARQUBE_CLI_TOKEN: 'placeholder',
      SONARQUBE_CLI_ORG: 'example',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child[stream].destroy();
  const [code] = await once(child, 'close');

  expect(code).toBe(exitCode);
});

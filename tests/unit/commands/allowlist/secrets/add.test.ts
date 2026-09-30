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

// spyOn, never mock.module: the coverage run shares one process and a module mock has no teardown.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { allowlistSecretsAdd } from '@/commands/allowlist/secrets/add.ts';
import * as spawnSecretsCli from '@/commands/allowlist/secrets/spawn-secrets-cli.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

const originalIsTTY = process.stdin.isTTY;
let fake: FakeConsole;
let ctx: CommandInvocationContext;
let runSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fake = new FakeConsole();
  ctx = new CommandInvocationContext(fake);
  runSpy = spyOn(spawnSecretsCli, 'runSecretsAllowlistCommand').mockResolvedValue(undefined);
});

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  runSpy.mockRestore();
});

describe('allowlistSecretsAdd', () => {
  it('refuses to run and never spawns the binary when stdin is not a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const error = await allowlistSecretsAdd(ctx).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as Error).message).toBe(
      'sonar allowlist secrets add requires a human at an interactive terminal; it cannot be run by an agent or script.',
    );
    expect((error as CommandFailedError).remediationHint).toBe(
      'Open a terminal and run this command there. Coding agents cannot add allowlist entries on your behalf.',
    );
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('runs the binary when stdin is a real TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    await allowlistSecretsAdd(ctx);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith(['add'], fake);
  });
});

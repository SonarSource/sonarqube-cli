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

/**
 * `remove` is now gated on a real interactive terminal, the same human-presence check as
 * `add`, because removing an entry re-flags a value a human previously approved. `clear` stays
 * a pure passthrough with no gating of its own: the binary already owns its own confirm-or-force
 * step, so re-checking `process.stdin.isTTY` here would produce two independent confirmation
 * prompts back to back. The organic behavior (real exit codes, real confirm/--force handling)
 * is covered by tests/integration/specs/allowlist/secrets.test.ts against the real fixture
 * binary.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { allowlistSecretsClear } from '@/commands/allowlist/secrets/clear.ts';
import { allowlistSecretsRemove } from '@/commands/allowlist/secrets/remove.ts';
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

describe('allowlistSecretsRemove', () => {
  it('forwards the key as-is to the shared spawn wrapper', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    await allowlistSecretsRemove('sqs-local-token-2026-09', ctx);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith(['remove', 'sqs-local-token-2026-09'], fake);
  });

  it('refuses to run and never spawns the binary when stdin is not a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const error = await allowlistSecretsRemove('some-key', ctx).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as Error).message).toBe(
      'sonar allowlist secrets remove requires a human at an interactive terminal; it cannot be run by an agent or script.',
    );
    expect((error as CommandFailedError).remediationHint).toBe(
      'Open a terminal and run this command there. Coding agents cannot remove allowlist entries on your behalf.',
    );
    expect(runSpy).not.toHaveBeenCalled();
  });
});

describe('allowlistSecretsClear', () => {
  it('omits --force when not requested', async () => {
    await allowlistSecretsClear({}, ctx);

    expect(runSpy).toHaveBeenCalledWith(['clear'], fake);
  });

  it('forwards --force when requested, and does nothing else with it', async () => {
    await allowlistSecretsClear({ force: true }, ctx);

    expect(runSpy).toHaveBeenCalledWith(['clear', '--force'], fake);
  });
});

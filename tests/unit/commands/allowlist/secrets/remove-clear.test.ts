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
 * `remove` and `clear` are both pure passthroughs with no gating of their own — deliberately,
 * per the refinement doc: `sonar-secrets allowlist clear` already owns its confirm-or-force
 * gate natively, so re-checking `process.stdin.isTTY` here would produce two independent
 * confirmation prompts back to back. The only thing worth unit-testing is that the args array
 * each one builds is exactly right; the organic behavior (real exit codes, real confirm/--force
 * handling) is covered by tests/integration/specs/allowlist/secrets.test.ts against the real
 * fixture binary.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { allowlistSecretsClear } from '@/commands/allowlist/secrets/clear.ts';
import { allowlistSecretsRemove } from '@/commands/allowlist/secrets/remove.ts';
import * as spawnSecretsCli from '@/commands/allowlist/secrets/spawn-secrets-cli.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

let fake: FakeConsole;
let ctx: CommandInvocationContext;
let runSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fake = new FakeConsole();
  ctx = new CommandInvocationContext(fake);
  runSpy = spyOn(spawnSecretsCli, 'runSecretsAllowlistCommand').mockResolvedValue(undefined);
});

afterEach(() => {
  runSpy.mockRestore();
});

describe('allowlistSecretsRemove', () => {
  it('forwards the key as-is to the shared spawn wrapper', async () => {
    await allowlistSecretsRemove('sqs-local-token-2026-09', ctx);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith(['remove', 'sqs-local-token-2026-09'], fake);
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

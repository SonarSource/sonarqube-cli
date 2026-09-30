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
 * Unit tests for the two failure paths of `runSecretsAllowlistCommand` that a fixture-binary
 * integration test cannot reach organically for `show` specifically: `show` takes no arguments,
 * so nothing a caller passes can make the real binary invocation fail, and the "binary can't
 * even start" path (EACCES/ENOEXEC/vanished) needs a broken executable to trigger for real.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { runSecretsAllowlistCommand } from '@/commands/allowlist/secrets/spawn-secrets-cli.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import * as installSecrets from '@/core/host/install/secrets.ts';
import * as processLib from '@/core/process/process.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

const FAKE_BINARY_PATH = '/fake/bin/sonar-secrets';

let fake: FakeConsole;
let installSecretsBinarySpy: ReturnType<typeof spyOn>;
let spawnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fake = new FakeConsole();
  installSecretsBinarySpy = spyOn(installSecrets, 'installSecretsBinary').mockResolvedValue(
    FAKE_BINARY_PATH,
  );
});

afterEach(() => {
  installSecretsBinarySpy.mockRestore();
  spawnSpy.mockRestore();
});

describe('runSecretsAllowlistCommand', () => {
  it('resolves without throwing when the binary exits 0', async () => {
    spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    await runSecretsAllowlistCommand(['show'], fake);

    expect(spawnSpy).toHaveBeenCalledWith(FAKE_BINARY_PATH, ['allowlist', 'show'], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
  });

  it('throws a CommandFailedError carrying the exit code when the binary exits non-zero', async () => {
    spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 2,
      stdout: '',
      stderr: '',
    });

    const error = await runSecretsAllowlistCommand(['remove', 'some-key'], fake).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as CommandFailedError).exitCode).toBe(2);
    expect((error as Error).message).toContain('sonar-secrets allowlist remove exited with code 2');
  });

  it('throws a CommandFailedError with a remediation hint when the binary cannot be executed', async () => {
    spawnSpy = spyOn(processLib, 'spawnProcess').mockRejectedValue(
      Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }),
    );

    const error = await runSecretsAllowlistCommand(['show'], fake).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as Error).message).toContain('Failed to run sonar-secrets: spawn EACCES');
    expect((error as CommandFailedError).remediationHint).toContain(FAKE_BINARY_PATH);
  });
});

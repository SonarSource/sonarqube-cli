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

import * as fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { type CliRuntime } from '@/core/commands/cli-runtime.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import * as installSecrets from '@/core/host/install/secrets.ts';

import * as analyzeSecrets from '../../../../src/commands/analyze/secrets.ts';
import { piPreToolUse } from '../../../../src/commands/hook/pi-pre-tool-use.ts';
import * as stdinModule from '../../../../src/commands/hook/stdin.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';
import { mockAuthResolver } from '../../../_common/mock-auth-resolver.ts';
import { useTempSonarUserHome } from '../../core/stats/_helpers.ts';

const TEST_FILE = '/sonar-test/test.ts';

const FAKE_AUTH = new ResolvedAuth({
  token: 'tok',
  serverUrl: 'https://sonarcloud.io',
  connectionType: 'cloud',
  source: 'state' as const,
  orgKey: 'myorg',
});

let runtime: CliRuntime;

function makeCtx() {
  return new CommandInvocationContext(new FakeConsole(), undefined, runtime);
}

describe('piPreToolUse', () => {
  useTempSonarUserHome('sonar-pi-pre-tool-use-');

  let stdoutSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let readStdinJsonSpy: ReturnType<typeof spyOn>;
  let resolveSecretsBinaryPathSpy: ReturnType<typeof spyOn>;
  let scanFilesSpy: ReturnType<typeof spyOn>;
  let existsSyncSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const mocked = mockAuthResolver(FAKE_AUTH);
    runtime = mocked.runtime;
    resolveAuthSpy = mocked.resolveAuthSpy;
    readStdinJsonSpy = spyOn(stdinModule, 'readStdinJson').mockResolvedValue({
      tool: 'read',
      filePath: TEST_FILE,
      sessionID: 'session-1',
    });
    resolveSecretsBinaryPathSpy = spyOn(installSecrets, 'resolveSecretsBinaryPath').mockReturnValue(
      '/usr/bin/sonar-secrets',
    );
    scanFilesSpy = spyOn(analyzeSecrets, 'runSecretsBinary').mockResolvedValue({
      exitCode: 2,
      stdout: '',
      stderr: '',
    });
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    resolveAuthSpy.mockRestore();
    readStdinJsonSpy.mockRestore();
    resolveSecretsBinaryPathSpy.mockRestore();
    scanFilesSpy.mockRestore();
    existsSyncSpy.mockRestore();
  });

  it('blocks when the scanner exits with a code that is neither clean nor secrets found', async () => {
    await piPreToolUse(makeCtx());

    const decision = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim()) as {
      block: boolean;
      reason?: string;
    };
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain('exit code 2');
  });
});

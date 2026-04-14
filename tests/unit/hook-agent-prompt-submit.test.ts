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

// Unit tests for agentPromptSubmit — only paths that cannot be exercised via integration tests:
//   • catch block when runSecretsBinaryOnText throws (no way to make the real binary throw)
//   • exitCode null branch (real binary always returns an integer exit code)

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as authResolver from '../../src/lib/auth-resolver';
import * as stdinModule from '../../src/cli/commands/hook/stdin';
import * as installSecrets from '../../src/cli/commands/_common/install/secrets';
import * as analyzeSecrets from '../../src/cli/commands/analyze/secrets';
import { agentPromptSubmit } from '../../src/cli/commands/hook/agent-prompt-submit';

describe('agentPromptSubmit (unit — impractical-via-e2e paths)', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let readStdinJsonSpy: ReturnType<typeof spyOn>;
  let resolveSecretsBinaryPathSpy: ReturnType<typeof spyOn>;
  let runSecretsBinaryOnTextSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue({
      token: 'tok',
      serverUrl: 'https://sonarcloud.io',
      connectionType: 'cloud',
      orgKey: 'myorg',
    });
    readStdinJsonSpy = spyOn(stdinModule, 'readStdinJson').mockResolvedValue({
      prompt: 'help me refactor this',
    });
    resolveSecretsBinaryPathSpy = spyOn(installSecrets, 'resolveSecretsBinaryPath').mockReturnValue(
      '/usr/bin/sonar-secrets',
    );
    runSecretsBinaryOnTextSpy = spyOn(analyzeSecrets, 'runSecretsBinaryOnText').mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    resolveAuthSpy.mockRestore();
    readStdinJsonSpy.mockRestore();
    resolveSecretsBinaryPathSpy.mockRestore();
    runSecretsBinaryOnTextSpy.mockRestore();
  });

  it('outputs nothing and does not throw when scan throws an error', async () => {
    runSecretsBinaryOnTextSpy.mockRejectedValue(new Error('scan process crashed'));

    await agentPromptSubmit();

    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('outputs nothing when exitCode is null', async () => {
    runSecretsBinaryOnTextSpy.mockResolvedValue({ exitCode: null, stdout: '', stderr: '' });

    await agentPromptSubmit();

    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

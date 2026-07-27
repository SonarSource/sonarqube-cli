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

// Unit tests for analyzeAll JSON-mode paths.
// Integration tests cannot control what the binary writes to errors[], so we test
// the SecretsReport.warnings field via unit test by mocking spawnProcess.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { ResolvedAuth } from '@/core/host/auth-resolver.ts';
import * as installSecrets from '@/core/host/install/secrets.ts';
import * as processLib from '@/core/process/process.ts';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '@/core/ui';

import { analyzeAll } from '../../../../src/commands/analyze/analyze-all.ts';
import * as sqaaModule from '../../../../src/commands/analyze/sqaa.ts';
import * as sqaaFileArg from '../../../../src/commands/analyze/sqaa-file-arg.ts';

const FAKE_AUTH: ResolvedAuth = {
  token: 'tok',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'myorg',
  connectionType: 'cloud',
};

describe('analyzeAll --format json: SecretsReport.warnings', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let resolveSecretsBinaryPathSpy: ReturnType<typeof spyOn>;
  let resolveSqaaFileArgsSpy: ReturnType<typeof spyOn>;
  let buildSqaaJsonReportSpy: ReturnType<typeof spyOn>;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    setMockUi(true);
    clearMockUiCalls();
    resolveSecretsBinaryPathSpy = spyOn(installSecrets, 'resolveSecretsBinaryPath').mockReturnValue(
      '/fake/sonar-secrets',
    );
    spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [] }),
      stderr: '',
    });
    // Isolate the secrets-report assertions: bypass on-disk file validation and the
    // agentic (SQAA) report so these tests only exercise the secrets JSON output path.
    resolveSqaaFileArgsSpy = spyOn(sqaaFileArg, 'resolveSqaaFileArgs').mockReturnValue([
      { absolutePath: 'test.ts' },
    ]);
    buildSqaaJsonReportSpy = spyOn(sqaaModule, 'buildSqaaJsonReport').mockResolvedValue(null);
  });

  afterEach(() => {
    process.exitCode = savedExitCode ?? 0;
    setMockUi(false);
    spawnSpy.mockRestore();
    resolveSecretsBinaryPathSpy.mockRestore();
    resolveSqaaFileArgsSpy.mockRestore();
    buildSqaaJsonReportSpy.mockRestore();
  });

  it('includes warnings[] in JSON output when binary reports errors[] on clean scan', async () => {
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        issues: [],
        errors: ['auth failed — partial scan only'],
      }),
      stderr: '',
    });

    await analyzeAll({ file: ['test.ts'], format: 'json' }, FAKE_AUTH);

    const prints = getMockUiCalls()
      .filter((c) => c.method === 'print')
      .map((c) => String(c.args[0]));
    expect(prints.length).toBeGreaterThan(0);
    const parsed = JSON.parse(prints[0]) as { secrets: { warnings?: string[]; error?: string } };
    expect(parsed.secrets.warnings).toEqual(['auth failed — partial scan only']);
    // Clean scan (exit 0) must not populate a spurious "unexpected code 0" error.
    expect(parsed.secrets.error).toBeUndefined();
  });

  it('omits warnings[] from JSON output when binary errors[] is empty', async () => {
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [], errors: [] }),
      stderr: '',
    });

    await analyzeAll({ file: ['test.ts'], format: 'json' }, FAKE_AUTH);

    const prints = getMockUiCalls()
      .filter((c) => c.method === 'print')
      .map((c) => String(c.args[0]));
    expect(prints.length).toBeGreaterThan(0);
    const parsed = JSON.parse(prints[0]) as { secrets: { warnings?: string[] } };
    expect(parsed.secrets.warnings).toBeUndefined();
  });

  it('includes warnings[] in JSON output when binary reports errors[] alongside secrets (exit 51)', async () => {
    spawnSpy.mockResolvedValue({
      exitCode: 51,
      stdout: JSON.stringify({
        issues: [
          {
            ruleKey: 'secrets:S6290',
            description: 'AWS Access Key',
            file: 'test.ts',
            location: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 20 },
          },
        ],
        errors: ['scan was incomplete'],
      }),
      stderr: '',
    });

    await analyzeAll({ file: ['test.ts'], format: 'json' }, FAKE_AUTH);

    const prints = getMockUiCalls()
      .filter((c) => c.method === 'print')
      .map((c) => String(c.args[0]));
    expect(prints.length).toBeGreaterThan(0);
    const parsed = JSON.parse(prints[0]) as {
      secrets: { warnings?: string[]; issues: unknown[] };
    };
    expect(parsed.secrets.warnings).toEqual(['scan was incomplete']);
    expect(parsed.secrets.issues).toHaveLength(1);
  });
});

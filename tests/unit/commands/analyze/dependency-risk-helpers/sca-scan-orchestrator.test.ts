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

import { describe, expect, it, mock, spyOn } from 'bun:test';

import * as scaTelemetry from '@/commands/analyze/sca-analysis-telemetry.ts';
import { SCA_CALLER_COMMANDS } from '@/commands/analyze/sca-analysis-telemetry.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import type { SecretsInstaller } from '@/core/host/install/secrets.ts';
import type { SonarQubeClient } from '@/core/server/client.ts';
import type { SettingsValue } from '@/core/server/settings-value.ts';

import { ScaScanOrchestrator } from '../../../../../src/commands/analyze/dependency-risk-helpers/sca-scan-orchestrator.ts';
import { FakeConsole } from '../../../../_common/fake-console.ts';
import { okScaInstaller as okInstaller } from './_helpers.ts';

const CLOUD_AUTH: ResolvedAuth = {
  connectionType: 'cloud',
  serverUrl: 'https://sonarcloud.io',
  token: 'test-token',
  orgKey: 'my-org',
};

const EMPTY_RESPONSE = { releases: [], parsedFiles: [], errors: [] };

function makeClient(
  overrides: {
    checkScaEnabled?: () => Promise<boolean>;
    getProjectSettings?: () => Promise<SettingsValue[]>;
  } = {},
): SonarQubeClient {
  return {
    checkScaEnabled: overrides.checkScaEnabled ?? (() => Promise.resolve(true)),
    getProjectSettings: overrides.getProjectSettings ?? (() => Promise.resolve([])),
  } as unknown as SonarQubeClient;
}

// The orchestrator runs `discover-manifests` (pre-scan) before `analyze-project`.
// Discovery reports no manifests so the secrets pre-scan is a no-op, then the
// scan call returns the supplied analyze-project payload.
function mockSpawner(payload: unknown) {
  return mock((_binaryPath: string, args: string[], _env?: Record<string, string>) => {
    const stdout =
      args[0] === 'discover-manifests' ? JSON.stringify({ files: [] }) : JSON.stringify(payload);
    return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
  });
}

// sonar-secrets is never resolved because discovery returns no manifests.
const noopSecretsInstaller: SecretsInstaller = { install: () => Promise.resolve(null) };

function makeCtx() {
  return new CommandInvocationContext(new FakeConsole());
}

describe('ScaScanOrchestrator', () => {
  it('returns the scanner response on a successful scan', async () => {
    const orchestrator = new ScaScanOrchestrator(
      makeClient(),
      okInstaller,
      { spawn: mockSpawner(EMPTY_RESPONSE) },
      noopSecretsInstaller,
    );

    const result = await orchestrator.run(
      CLOUD_AUTH,
      'my-project',
      SCA_CALLER_COMMANDS.analyzeDependencyRisks,
      makeCtx(),
    );

    expect(result.response).toEqual(EMPTY_RESPONSE);
    expect(result.scanDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('throws when SCA is not available for the connection', async () => {
    const orchestrator = new ScaScanOrchestrator(
      makeClient({ checkScaEnabled: () => Promise.resolve(false) }),
      okInstaller,
      { spawn: mockSpawner(EMPTY_RESPONSE) },
      noopSecretsInstaller,
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      orchestrator.run(
        CLOUD_AUTH,
        'my-project',
        SCA_CALLER_COMMANDS.analyzeDependencyRisks,
        makeCtx(),
      ),
    ).rejects.toBeInstanceOf(CommandFailedError);
  });

  it('passes projectKey and token from auth into the scanner invocation', async () => {
    const spawn = mockSpawner(EMPTY_RESPONSE);
    const orchestrator = new ScaScanOrchestrator(
      makeClient(),
      okInstaller,
      { spawn },
      noopSecretsInstaller,
    );

    await orchestrator.run(
      CLOUD_AUTH,
      'my-project',
      SCA_CALLER_COMMANDS.analyzeDependencyRisks,
      makeCtx(),
    );

    const analyzeCall = spawn.mock.calls.find(([, args]) => args[0] === 'analyze-project');
    expect(analyzeCall).toBeDefined();
    const [, args, env] = analyzeCall!;
    expect(args).toContain('--project-key=my-project');
    expect(args.some((arg) => arg.includes('--sonar-token'))).toBe(false);
    expect(env).toMatchObject({ SONAR_TOKEN: 'test-token' });
  });

  it('skips the analyze-project scan and emits no SCA telemetry when the manifest pre-scan throws', async () => {
    const emitSpy = spyOn(scaTelemetry, 'recordScaAnalysisTelemetry').mockImplementation(() => {});
    const spawn = mock((_binaryPath: string, args: string[]) => {
      if (args[0] === 'discover-manifests') {
        return Promise.reject(new Error('secrets pre-scan failed'));
      }
      return Promise.resolve({ exitCode: 0, stdout: JSON.stringify(EMPTY_RESPONSE), stderr: '' });
    });
    const orchestrator = new ScaScanOrchestrator(
      makeClient(),
      okInstaller,
      { spawn },
      noopSecretsInstaller,
    );

    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        orchestrator.run(
          CLOUD_AUTH,
          'my-project',
          SCA_CALLER_COMMANDS.analyzeDependencyRisks,
          makeCtx(),
        ),
      ).rejects.toThrow('secrets pre-scan failed');

      const subcommands = spawn.mock.calls.map(([, args]) => args[0]);
      expect(subcommands).toContain('discover-manifests');
      expect(subcommands).not.toContain('analyze-project');
      // A secrets pre-scan abort must never be recorded as an SCA failure.
      expect(emitSpy).not.toHaveBeenCalled();
    } finally {
      emitSpy.mockRestore();
    }
  });

  it('emits an SCA failures_count:1 event when the analyze-project scan itself fails', async () => {
    const emitSpy = spyOn(scaTelemetry, 'recordScaAnalysisTelemetry').mockImplementation(() => {});
    const spawn = mock((_binaryPath: string, args: string[]) => {
      if (args[0] === 'discover-manifests') {
        return Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ files: [] }), stderr: '' });
      }
      // analyze-project exits non-zero → ScaScannerRunner throws.
      return Promise.resolve({ exitCode: 2, stdout: '', stderr: 'scanner boom' });
    });
    const orchestrator = new ScaScanOrchestrator(
      makeClient(),
      okInstaller,
      { spawn },
      noopSecretsInstaller,
    );

    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        orchestrator.run(
          CLOUD_AUTH,
          'my-project',
          SCA_CALLER_COMMANDS.analyzeDependencyRisks,
          makeCtx(),
        ),
      ).rejects.toBeInstanceOf(CommandFailedError);

      expect(emitSpy).toHaveBeenCalledTimes(1);
      const [calledCtx, calledAuth, callerCommand, response, , exitCode] = emitSpy.mock.calls[0];
      expect(calledCtx).toBeDefined();
      expect(calledAuth).toBe(CLOUD_AUTH);
      expect(callerCommand).toBe(SCA_CALLER_COMMANDS.analyzeDependencyRisks);
      expect(response).toBeNull(); // null response ⇒ failures_count:1
      expect(exitCode).toBeNull();
    } finally {
      emitSpy.mockRestore();
    }
  });
});

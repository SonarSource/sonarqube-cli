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

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, mock } from 'bun:test';

import {
  CommandInvocationContext,
  createTelemetryFactBuffer,
} from '@/commands/command-invocation-context.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import type { SecretsInstaller } from '@/core/host/install/secrets.ts';
import type { SpawnResult } from '@/core/process/process.ts';

import type { ScaScannerSpawner } from '../../../../../src/commands/analyze/dependency-risk-helpers/sca-scanner-spawner.ts';
import { makeScaInvocation as makeInvocation, okScaInstaller } from './_helpers.ts';

// The guard calls `runSecretsBinary` from `../secrets`, which spawns a child
// process. Re-register the module with a stable wrapper that delegates to a
// swappable impl; the real exports (e.g. EXIT_CODE_SECRETS_FOUND) are preserved.
const secretsModule = await import('../../../../../src/commands/analyze/secrets.ts');
const { EXIT_CODE_SECRETS_FOUND } = secretsModule;

type RunSecretsBinary = (
  binaryPath: string,
  files: string[],
  auth: ResolvedAuth,
) => Promise<SpawnResult>;

const unconfiguredRunSecrets: RunSecretsBinary = () => {
  throw new Error('runSecretsImpl not configured for this test');
};

let runSecretsImpl: RunSecretsBinary = unconfiguredRunSecrets;

void mock.module('../../../../../src/commands/analyze/secrets.ts', () => ({
  ...secretsModule,
  runSecretsBinary: (binaryPath: string, files: string[], auth: ResolvedAuth) =>
    runSecretsImpl(binaryPath, files, auth),
}));

const { preScanManifestsForSecrets } =
  await import('../../../../../src/commands/analyze/dependency-risk-helpers/manifest-secrets-guard.ts');

const AUTH: ResolvedAuth = {
  connectionType: 'cloud',
  serverUrl: 'https://sonarcloud.io',
  token: 'test-token',
  orgKey: 'my-org',
};

const BASE_DIR = join(tmpdir(), 'manifest-guard-repo');

function makeCtx() {
  const buffer = createTelemetryFactBuffer();
  const ctx = new CommandInvocationContext(
    { isAlpha: false, isBeta: false, isPrivateBeta: false },
    { isAlphaEnabled: false, isPrivateBetaEnabled: () => false },
    buffer,
  );
  return { ctx, buffer };
}

// Spawner that returns the given manifest file list from `discover-manifests`.
function discoverSpawner(files: unknown[]): ScaScannerSpawner {
  return {
    spawn: () => Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ files }), stderr: '' }),
  };
}

function secretsInstallerReturning(path: string | null): SecretsInstaller {
  return { install: () => Promise.resolve(path) };
}

// Installs a fake `runSecretsBinary` returning `result` and returns the spy.
function stubRunSecretsBinary(result: SpawnResult) {
  const spy = mock((_binaryPath: string, _files: string[], _auth: ResolvedAuth) =>
    Promise.resolve(result),
  );
  runSecretsImpl = spy;
  return spy;
}

async function runGuard(deps: {
  files: unknown[];
  secretsInstaller: SecretsInstaller;
}): Promise<void> {
  await preScanManifestsForSecrets({
    invocation: makeInvocation(),
    baseDir: BASE_DIR,
    auth: AUTH,
    scaInstaller: okScaInstaller,
    scaSpawner: discoverSpawner(deps.files),
    secretsInstaller: deps.secretsInstaller,
    ctx: makeCtx().ctx,
  });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('preScanManifestsForSecrets', () => {
  beforeEach(() => {
    runSecretsImpl = unconfiguredRunSecrets;
  });

  it('returns early without resolving the secrets binary when no manifests are discovered', async () => {
    const install = mock(() => Promise.resolve('/bin/secrets'));
    const runSpy = stubRunSecretsBinary({ exitCode: 0, stdout: '', stderr: '' });

    await runGuard({ files: [], secretsInstaller: { install } });

    expect(install).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('skips silently when sonar-secrets is not installed', async () => {
    const runSpy = stubRunSecretsBinary({ exitCode: 0, stdout: '', stderr: '' });

    await runGuard({ files: ['package.json'], secretsInstaller: secretsInstallerReturning(null) });

    expect(runSpy).not.toHaveBeenCalled();
  });

  it('completes without throwing when no secrets are found (exit 0)', async () => {
    const runSpy = stubRunSecretsBinary({ exitCode: 0, stdout: '', stderr: '' });

    const error = await captureError(
      runGuard({
        files: ['package.json'],
        secretsInstaller: secretsInstallerReturning('/bin/secrets'),
      }),
    );

    expect(error).toBeUndefined();
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('throws a CommandFailedError with formatted findings when secrets are detected', async () => {
    const stdout = JSON.stringify({
      issues: [
        {
          ruleKey: 'secrets:S6290',
          description: 'AWS access key detected',
          file: 'package.json',
          location: { startLine: 12, startColumn: 5, endLine: 12, endColumn: 40 },
          maskedSecret: 'AKIA****',
        },
      ],
    });
    stubRunSecretsBinary({ exitCode: EXIT_CODE_SECRETS_FOUND, stdout, stderr: '' });

    const error = await captureError(
      runGuard({
        files: ['package.json'],
        secretsInstaller: secretsInstallerReturning('/bin/secrets'),
      }),
    );

    expect(error).toBeInstanceOf(CommandFailedError);
    const commandError = error as CommandFailedError;
    expect(commandError.message).toContain('Secrets detected in dependency manifest files');
    expect(commandError.message).toContain('package.json:12 — AWS access key detected');
    expect(commandError.message).toContain('(secret: AKIA****)');
    expect(commandError.remediationHint).toContain('Remove the reported secret');
  });

  it('omits the location and secret details when the finding has none', async () => {
    const stdout = JSON.stringify({
      issues: [
        { ruleKey: 'secrets:S2068', description: 'Hardcoded password', file: 'package.json' },
      ],
    });
    stubRunSecretsBinary({ exitCode: EXIT_CODE_SECRETS_FOUND, stdout, stderr: '' });

    const error = await captureError(
      runGuard({
        files: ['package.json'],
        secretsInstaller: secretsInstallerReturning('/bin/secrets'),
      }),
    );

    expect(error).toBeInstanceOf(CommandFailedError);
    const message = (error as CommandFailedError).message;
    expect(message).toContain('• package.json — Hardcoded password');
    expect(message).not.toMatch(/package\.json:\d/);
    expect(message).not.toContain('(secret:');
  });

  it('throws a CommandFailedError for any other non-zero exit code', async () => {
    stubRunSecretsBinary({ exitCode: 2, stdout: 'out', stderr: 'error' });

    const error = await captureError(
      runGuard({
        files: ['package.json'],
        secretsInstaller: secretsInstallerReturning('/bin/secrets'),
      }),
    );

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as CommandFailedError).message).toContain(
      'Secrets scan of dependency manifests failed (exit code 2)',
    );
  });

  it('resolves relative manifest paths against baseDir and leaves absolute paths intact', async () => {
    const runSpy = stubRunSecretsBinary({ exitCode: 0, stdout: '', stderr: '' });
    const absoluteManifest = join(tmpdir(), 'external', 'pom.xml');

    await runGuard({
      files: ['package.json', absoluteManifest],
      secretsInstaller: secretsInstallerReturning('/bin/secrets'),
    });

    expect(runSpy).toHaveBeenCalledWith(
      '/bin/secrets',
      [join(BASE_DIR, 'package.json'), absoluteManifest],
      AUTH,
    );
  });
});

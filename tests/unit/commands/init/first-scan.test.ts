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

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { DetectDeps } from '@/commands/init/steps/detect.ts';
import {
  NOT_RUN,
  reportScan,
  runFirstScan,
  type ScanFlags,
  type ScanResult,
} from '@/commands/init/steps/scan.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import { clearNetworkConfigCache } from '@/core/host/connectivity/network-config.ts';
import { errAsync, okAsync } from '@/core/result.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';
import { restoreEnv } from '../../../_common/isolated-cli-env.ts';
import { isolateNetworkEnv } from '../../../_common/network-env.ts';
import { writeExecutable, writeFakeLauncher } from '../../core/host/install/fake-scanner.ts';
import { createKeychainTestHandle } from '../../core/host/keychain-test-handle.ts';

const TOKEN = 'squ_first_scan_token';
const posixOnly = process.platform === 'win32' ? describe.skip : describe;
const keychain = createKeychainTestHandle();

let root: string;
let projectRoot: string;
let restoreNetworkEnv: () => void;
let previousPath: string | undefined;
let previousUserHome: string | undefined;
let logPaths: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'first-scan-test-'));
  projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  restoreNetworkEnv = isolateNetworkEnv();
  previousPath = process.env.PATH;
  previousUserHome = process.env[ENV_SONAR_USER_HOME];
  process.env[ENV_SONAR_USER_HOME] = join(root, 'user-home');
  clearNetworkConfigCache();
  keychain.setup();
  logPaths = [];
});

afterEach(() => {
  clearNetworkConfigCache();
  keychain.teardown();
  restoreNetworkEnv();
  restoreEnv('PATH', previousPath);
  restoreEnv(ENV_SONAR_USER_HOME, previousUserHome);
  for (const logPath of logPaths) rmSync(logPath, { force: true });
  rmSync(root, { recursive: true, force: true });
});

function auth(serverUrl = 'https://sonar.example'): ResolvedAuth {
  return new ResolvedAuth({
    token: TOKEN,
    serverUrl,
    orgKey: 'my-org',
    connectionType: 'cloud',
    source: 'env',
  });
}

type Routes = Record<string, unknown>;

function httpAnswering(overrides: Routes = {}): SonarHttpClient {
  const routes: Routes = {
    '/api/ce/task': {
      task: { id: 'task-1', componentKey: 'my-key', status: 'SUCCESS', analysisId: 'an-1' },
    },
    '/api/qualitygates/project_status': { projectStatus: { status: 'OK' } },
    '/api/issues/search': { total: 7 },
    ...overrides,
  };
  return {
    get: (path: string) => {
      const answer = routes[path];
      return answer instanceof Error || answer === undefined
        ? errAsync(answer ?? new Error(`unexpected request to ${path}`))
        : okAsync(answer);
    },
  } as unknown as SonarHttpClient;
}

function depsFor(
  console: FakeConsole,
  options: { interactive?: boolean; routes?: Routes; serverUrl?: string } = {},
): DetectDeps {
  return {
    auth: auth(options.serverUrl),
    http: httpAnswering(options.routes),
    console,
    interactive: options.interactive ?? false,
  };
}

function flags(overrides: Partial<ScanFlags> = {}): ScanFlags {
  return {
    scannerProperties: new Map([['sonar.sources', '.']]),
    verbose: false,
    detach: false,
    ...overrides,
  };
}

/** A scanner on the PATH whose `java` prints a line and writes the report, or fails. */
function installScanner(exitCode = 0): void {
  const launcher = writeFakeLauncher(root);
  writeExecutable(launcher.javaPath, [
    '#!/bin/sh',
    'for arg in "$@"; do case "$arg" in',
    '  --version) echo "SonarScanner CLI 8.1.0.6389"; exit 0;;',
    '  -Dsonar.scanner.metadataFilePath=*) report="${arg#*=}";;',
    'esac; done',
    'echo "scanner says hello, token $SONAR_TOKEN"',
    `if [ ${exitCode} -eq 0 ]; then printf 'ceTaskId=task-1\\nprojectKey=my-key\\n' > "$report"; fi`,
    `exit ${exitCode}`,
  ]);
  process.env.PATH = `${launcher.binDir}${delimiter}${previousPath ?? ''}`;
}

async function failureOf(promise: Promise<unknown>): Promise<CommandFailedError> {
  const error = await promise.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(CommandFailedError);
  return error as CommandFailedError;
}

function printed(console: FakeConsole): string[] {
  return console.calls
    .filter((call) => call.method === 'print')
    .map((call) => String(call.args[0]));
}

describe('runFirstScan without a scan', () => {
  it('does not scan a non-interactive run that passed no scan flag', async () => {
    const console = new FakeConsole();
    const none = flags({ scannerProperties: new Map() });

    expect(await runFirstScan(projectRoot, 'my-key', depsFor(console), none)).toBe(NOT_RUN);
    expect(console.calls).toHaveLength(0);
  });

  it('does not scan when the user declines the offer', async () => {
    const console = new FakeConsole();
    console.queueResponse(false);

    const result = await runFirstScan(
      projectRoot,
      'my-key',
      depsFor(console, { interactive: true }),
      flags(),
    );

    expect(result).toBe(NOT_RUN);
    expect(console.calls.find((call) => call.method === 'confirmPrompt')?.args[0]).toBe(
      'Run the first analysis with sonar-scanner now?',
    );
  });

  it('stops the onboarding when the user cancels the offer', async () => {
    const console = new FakeConsole();
    console.queueResponse(null);

    const error = await runFirstScan(
      projectRoot,
      'my-key',
      depsFor(console, { interactive: true }),
      flags(),
    ).catch((cause: unknown) => cause);

    expect((error as Error).message).toBe('Onboarding cancelled.');
  });
});

describe('runFirstScan failures', () => {
  it('says the project was kept when the network setup is unusable, before any download', async () => {
    process.env.SONAR_HTTPS_PROXY_URL = 'https://proxy.local:8443';
    clearNetworkConfigCache();

    const error = await failureOf(
      runFirstScan(projectRoot, 'my-key', depsFor(new FakeConsole()), flags()),
    );

    expect(error.message).toBe(
      'The first analysis did not complete: The SonarScanner requires an HTTP proxy URL.',
    );
    expect(error.remediationHint).toContain(
      "Project 'my-key' and .sonar-config.json were kept, so the setup is intact.",
    );
  });

  it('refuses --detach with a PEM client key before downloading the scanner', async () => {
    const fixtures = join(import.meta.dir, '../../../fixtures/client-cert');
    process.env.SONAR_TLS_CLIENT_CERT = join(fixtures, 'client-cert.pem');
    process.env.SONAR_TLS_CLIENT_KEY_FILE = join(fixtures, 'client-key.pem');
    clearNetworkConfigCache();

    const error = await failureOf(
      runFirstScan(projectRoot, 'my-key', depsFor(new FakeConsole()), flags({ detach: true })),
    );

    expect(error.message).toContain('A PEM client key cannot be used with --detach.');
    expect(error.remediationHint).toContain('were kept');
  });

  posixOnly('when the scanner fails', () => {
    it('keeps the project and points to the scanner log', async () => {
      installScanner(1);

      const error = await failureOf(
        runFirstScan(projectRoot, 'my-key', depsFor(new FakeConsole()), flags()),
      );

      expect(error.message).toBe(
        'The first analysis did not complete: SonarScanner exited with code 1.',
      );
      expect(error.remediationHint).toContain("Project 'my-key'");
      expect(error.remediationHint).toContain('sonar-scanner-');
    });
  });

  posixOnly('when the server rejects the analysis', () => {
    it('keeps the project and reports why processing failed', async () => {
      installScanner();
      const routes = {
        '/api/ce/task': {
          task: { id: 'task-1', componentKey: 'my-key', status: 'FAILED', errorMessage: 'bad' },
        },
      };

      const error = await failureOf(
        runFirstScan(projectRoot, 'my-key', depsFor(new FakeConsole(), { routes }), flags()),
      );

      expect(error.message).toBe(
        'The first analysis did not complete: Analysis processing failed: bad',
      );
    });
  });
});

posixOnly('runFirstScan in the foreground', () => {
  async function scan(
    routes: Routes = {},
    scanFlags = flags(),
    console = new FakeConsole(),
  ): Promise<Extract<ScanResult, { status: 'completed' }>> {
    const result = await runFirstScan(
      projectRoot,
      'my-key',
      depsFor(console, { routes }),
      scanFlags,
    );
    expect(result.status).toBe('completed');
    const completed = result as Extract<ScanResult, { status: 'completed' }>;
    logPaths.push(completed.logPath);
    return completed;
  }

  it('runs the scanner, waits for the server and reads the results of that analysis', async () => {
    installScanner();

    const result = await scan();

    expect(result).toMatchObject({
      taskId: 'task-1',
      analysisId: 'an-1',
      qualityGate: 'OK',
      openIssues: 7,
    });
  });

  it('shows the scanner output live, without the token, when verbose', async () => {
    installScanner();
    const console = new FakeConsole();

    await scan({}, flags({ verbose: true }), console);

    const lines = printed(console);
    expect(lines.some((line) => line.includes('scanner says hello'))).toBe(true);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(console.calls.some((call) => call.method === 'spinner')).toBe(true);
  });

  it('reports a missing quality gate as unknown, never as a pass', async () => {
    installScanner();

    const result = await scan({ '/api/qualitygates/project_status': new Error('500') });

    expect(result.qualityGate).toBeNull();
    expect(result.openIssues).toBe(7);
  });

  it('reports a missing issue count as unknown, never as zero', async () => {
    installScanner();

    const result = await scan({ '/api/issues/search': new Error('500') });

    expect(result.qualityGate).toBe('OK');
    expect(result.openIssues).toBeNull();
  });
});

describe('reportScan', () => {
  const completed = (overrides: Partial<Extract<ScanResult, { status: 'completed' }>> = {}) =>
    ({
      status: 'completed',
      taskId: 't',
      analysisId: 'a',
      logPath: '/log',
      qualityGate: 'OK',
      openIssues: 3,
      ...overrides,
    }) as ScanResult;

  it('prints nothing when no scan ran', () => {
    const console = new FakeConsole();

    reportScan(NOT_RUN, 'my-key', console);

    expect(console.calls).toHaveLength(0);
  });

  it('says the results are unknown for a scan handed to the background', () => {
    const console = new FakeConsole();

    reportScan({ status: 'started', pid: 42, logPath: '/tmp/scan.log' }, 'my-key', console);

    expect(printed(console)).toEqual([
      'Analysis started in the background (process 42); the results are not known yet.',
      'Scanner log: /tmp/scan.log',
      'Check the results with: sonar quality-gate status -p my-key',
    ]);
  });

  it.each([
    ['OK', 'passed'],
    ['WARN', 'passed with warnings'],
    ['ERROR', 'failed'],
    ['NONE', 'not configured for this project'],
  ] as const)('describes the %s quality gate as %s, without an error', (gate, text) => {
    const console = new FakeConsole();

    reportScan(completed({ qualityGate: gate }), 'my-key', console);

    expect(console.calls.some((call) => call.method === 'success')).toBe(true);
    expect(printed(console)).toEqual([
      `Quality gate: ${text}. See: sonar quality-gate status -p my-key`,
      'Open issues: 3',
    ]);
  });

  it('says so when the quality gate or the issue count could not be read', () => {
    const console = new FakeConsole();

    reportScan(completed({ qualityGate: null, openIssues: null }), 'my-key', console);

    expect(printed(console)).toEqual([
      'Quality gate: not available.',
      'Open issues: not available.',
    ]);
  });
});

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

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  runScanner,
  type ScannerRun,
  startScannerInBackground,
} from '@/commands/init/scan/run-scanner.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';

const TOKEN = 'squ_super_secret_token';
const PROPERTY_VALUE = 'proxy-pass-12345';
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

posixOnly('runScanner', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'run-scanner-test-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** A stand-in for `java`: echoes the secrets it was given and writes the metadata report. */
  function stubJava(exitCode: number): string {
    const path = join(directory, 'java');
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        'for arg in "$@"; do case "$arg" in -Dsonar.scanner.metadataFilePath=*) report="${arg#*=}";; esac; done',
        'echo "token=$SONAR_TOKEN params=$SONAR_SCANNER_JSON_PARAMS"',
        'echo "args: $*"',
        `if [ ${exitCode} -eq 0 ]; then printf 'ceTaskId=task-1\\nprojectKey=my-key\\n' > "$report"; fi`,
        `exit ${exitCode}`,
      ].join('\n'),
    );
    chmodSync(path, 0o755);
    return path;
  }

  function newRun(
    javaPath: string,
    connection: { serverUrl: string; connectionType: 'cloud' | 'on-premise' } = {
      serverUrl: 'https://sonarcloud.io',
      connectionType: 'cloud',
    },
  ): ScannerRun {
    return {
      scanner: { home: directory, javaPath, classPath: directory, version: '8.3.1.16491' },
      projectRoot: directory,
      projectKey: 'my-key',
      auth: new ResolvedAuth({
        token: TOKEN,
        ...connection,
        orgKey: 'my-org',
        source: 'env',
      }),
      directory,
      networkEnv: {},
      scannerProperties: new Map([['sonar.some.setting', PROPERTY_VALUE]]),
    };
  }

  it('returns the task id and keeps the token and property values out of the log and live output', async () => {
    const live: string[] = [];
    const { taskId, logPath } = await runScanner(newRun(stubJava(0)), {
      print: (line) => live.push(line),
    });

    expect(taskId).toBe('task-1');
    const log = readFileSync(logPath, 'utf8');
    for (const text of [log, live.join('\n')]) {
      expect(text).toContain('[REDACTED]');
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(PROPERTY_VALUE);
    }
    rmSync(logPath);
  });

  async function scannerArgs(run: ScannerRun): Promise<string[]> {
    const live: string[] = [];
    const { logPath } = await runScanner(run, { print: (line) => live.push(line) });
    rmSync(logPath);
    return (live.find((line) => line.startsWith('args:')) ?? '').split(' ');
  }

  it.each([
    ['https://sonarcloud.io', 'https://sonarcloud.io', 'https://api.sonarcloud.io'],
    ['https://sonarqube.us', 'https://sonarqube.us', 'https://api.sonarqube.us'],
  ])(
    'pins the endpoints of the Cloud host %s so a repository cannot redirect the token',
    async (serverUrl, sonarcloudUrl, apiBaseUrl) => {
      const args = await scannerArgs(newRun(stubJava(0), { serverUrl, connectionType: 'cloud' }));
      expect(args).toContain(`-Dsonar.scanner.sonarcloudUrl=${sonarcloudUrl}`);
      expect(args).toContain(`-Dsonar.scanner.apiBaseUrl=${apiBaseUrl}`);
    },
  );

  it('pins a server to the stock Cloud URLs, so it is never taken for Cloud', async () => {
    const serverUrl = 'https://sonar.example.com';
    const args = await scannerArgs(
      newRun(stubJava(0), { serverUrl, connectionType: 'on-premise' }),
    );
    expect(args).toContain(`-Dsonar.host.url=${serverUrl}`);
    expect(args).toContain('-Dsonar.scanner.sonarcloudUrl=https://sonarcloud.io');
    expect(args).toContain('-Dsonar.scanner.apiBaseUrl=https://api.sonarcloud.io');
  });

  it('passes no property value or token on the command line', async () => {
    const live: string[] = [];
    const { logPath } = await runScanner(newRun(stubJava(0)), { print: (line) => live.push(line) });
    const args = live.find((line) => line.startsWith('args:')) ?? '';
    expect(args).toContain('-Dsonar.projectKey=my-key');
    expect(args).not.toContain('sonar.some.setting');
    rmSync(logPath);
  });

  it('fails with a hint pointing at the log when the scanner exits non-zero', async () => {
    const error = await runScanner(newRun(stubJava(3))).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as CommandFailedError).message).toContain('code 3');
    expect((error as CommandFailedError).remediationHint).toContain('sonar-scanner-');
  });

  /** A `java` running the given shell lines, for the scanner behaviours the main stub lacks. */
  function scriptJava(...lines: string[]): string {
    const path = join(directory, 'script-java');
    writeFileSync(path, ['#!/bin/sh', ...lines].join('\n'));
    chmodSync(path, 0o755);
    return path;
  }

  async function failureOf(promise: Promise<unknown>): Promise<CommandFailedError> {
    const error = await promise.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CommandFailedError);
    return error as CommandFailedError;
  }

  describe('when the analysis task report is unusable', () => {
    it('fails when the scanner wrote no report', async () => {
      const error = await failureOf(runScanner(newRun(scriptJava('exit 0'))));

      expect(error.message).toBe('SonarScanner did not produce an analysis task report.');
      expect(error.remediationHint).toContain('sonar-scanner-');
    });

    it.each([
      ['another project', "printf 'ceTaskId=task-1\\nprojectKey=other\\n'"],
      ['no task id', "printf 'projectKey=my-key\\n'"],
    ])('fails when the report names %s', async (_case, write) => {
      const java = scriptJava(
        'for arg in "$@"; do case "$arg" in -Dsonar.scanner.metadataFilePath=*) report="${arg#*=}";; esac; done',
        `${write} > "$report"`,
      );

      const error = await failureOf(runScanner(newRun(java)));

      expect(error.message).toBe('SonarScanner produced an invalid analysis task report.');
    });
  });

  it('stops a scanner that outlives its budget and says so in the log', async () => {
    const error = await failureOf(runScanner(newRun(scriptJava('sleep 5')), undefined, 200));

    expect(error.message).toBe('SonarScanner timed out.');
    expect(error.remediationHint).toContain('sonar-scanner-');
  });

  it('fails with a hint when the scanner cannot be started at all', async () => {
    const error = await failureOf(runScanner(newRun(join(directory, 'no-such-java'))));

    expect(error.remediationHint).toContain('sonar-scanner-');
  });
});

posixOnly('startScannerInBackground', () => {
  let directory: string;
  let pid: number | undefined;
  let logPath: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'run-scanner-background-test-'));
    pid = undefined;
    logPath = undefined;
  });

  afterEach(() => {
    if (pid !== undefined) {
      try {
        process.kill(pid);
      } catch {
        // The scanner has already exited.
      }
    }
    if (logPath) rmSync(logPath, { force: true });
    rmSync(directory, { recursive: true, force: true });
  });

  function runWith(javaPath: string): ScannerRun {
    return {
      scanner: { home: directory, javaPath, classPath: directory, version: '8.3.1.16491' },
      projectRoot: directory,
      projectKey: 'my-key',
      auth: new ResolvedAuth({
        token: TOKEN,
        serverUrl: 'https://sonarcloud.io',
        orgKey: 'my-org',
        connectionType: 'cloud',
        source: 'env',
      }),
      directory,
      networkEnv: {},
      scannerProperties: new Map(),
    };
  }

  function scriptJava(...lines: string[]): string {
    const path = join(directory, 'script-java');
    writeFileSync(path, ['#!/bin/sh', ...lines].join('\n'));
    chmodSync(path, 0o755);
    return path;
  }

  it('returns the pid of a scanner that keeps running, with its output in the log', async () => {
    const started = await startScannerInBackground(
      runWith(scriptJava('echo "args: $*"', 'sleep 5')),
    );
    ({ pid, logPath } = started);

    expect(started.pid).toBeGreaterThan(0);
    const deadline = Date.now() + 5000;
    let log = readFileSync(started.logPath, 'utf8');
    while (!log.includes('args:') && Date.now() < deadline) {
      await Bun.sleep(20);
      log = readFileSync(started.logPath, 'utf8');
    }
    expect(log.startsWith('SonarScanner 8.3.1.16491\nProject: my-key\n')).toBe(true);
    expect(log).toContain('-Dsonar.projectKey=my-key');
  });

  it('forces the scanner quiet, so a project file cannot make it echo its properties', async () => {
    const started = await startScannerInBackground(
      runWith(scriptJava('echo "args: $*"', 'sleep 5')),
    );
    ({ pid, logPath } = started);

    const deadline = Date.now() + 5000;
    let log = readFileSync(started.logPath, 'utf8');
    while (!log.includes('args:') && Date.now() < deadline) {
      await Bun.sleep(20);
      log = readFileSync(started.logPath, 'utf8');
    }
    expect(log).toContain('-Dsonar.verbose=false');
    expect(log).toContain('-Dsonar.log.level=INFO');
  });

  it('reports a scanner that dies at once instead of announcing it as started', async () => {
    const error = await startScannerInBackground(runWith(scriptJava('exit 2'))).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as CommandFailedError).message).toBe(
      'Could not start the SonarScanner in the background.',
    );
    expect((error as CommandFailedError).remediationHint).toContain('sonar-scanner-');
  });

  it('reports a scanner that cannot be started', async () => {
    const error = await startScannerInBackground(runWith(join(directory, 'no-such-java'))).catch(
      (cause: unknown) => cause,
    );

    expect((error as CommandFailedError).message).toBe(
      'Could not start the SonarScanner in the background.',
    );
  });
});

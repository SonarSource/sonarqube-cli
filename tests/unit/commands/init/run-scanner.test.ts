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

import { runScanner, type ScannerRun } from '@/commands/init/scan/run-scanner.ts';
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

  function newRun(javaPath: string): ScannerRun {
    return {
      scanner: { home: directory, javaPath, classPath: directory, version: '8.1.0.6389' },
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
});

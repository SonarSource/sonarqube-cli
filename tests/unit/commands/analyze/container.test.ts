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

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { analyzeContainer, type AnalyzeContainerOptions } from '@/commands/analyze/container.ts';
import * as runner from '@/commands/analyze/container-scanner-runner.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import * as installer from '@/core/host/install/container-scanner.ts';
import logger from '@/core/observability/logger.ts';
import { ServiceUnavailableError } from '@/core/server/errors.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

const IMAGE = './my-image.tar';
const DEFAULT_OPTIONS: AnalyzeContainerOptions = {
  timeoutSecs: 300,
  failOn: 'high',
  format: 'json',
};

function makeContext(token = 'container-secret-token'): {
  console: FakeConsole;
  ctx: CommandAuthenticatedInvocationContext;
} {
  const console = new FakeConsole();
  const auth = new ResolvedAuth({
    token,
    serverUrl: 'https://sonarcloud.io',
    orgKey: 'my-org',
    connectionType: 'cloud',
    source: 'env',
  });
  return { console, ctx: new CommandAuthenticatedInvocationContext(auth, console) };
}

describe('analyzeContainer', () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    spyOn(runner, 'prepareContainerScannerEnv').mockResolvedValue({});
  });

  afterEach(() => {
    process.exitCode = savedExitCode ?? 0;
    mock.restore();
  });

  it('prints remediationHint when installation fails with a hint-bearing error', async () => {
    const { console, ctx } = makeContext();
    spyOn(installer, 'installContainerScanner').mockRejectedValue(
      new ServiceUnavailableError('Binary CDN unavailable'),
    );

    await analyzeContainer(IMAGE, DEFAULT_OPTIONS, ctx);

    expect(process.exitCode).toBe(1);
    expect(console.findCall('error', 'Binary CDN unavailable')).toBeDefined();
    expect(
      console.findCall('print', '→ Check your network connection and try again later.'),
    ).toBeDefined();
    const jsonCall = console.calls.find(
      (c) => c.method === 'print' && typeof c.args[0] === 'string' && c.args[0].startsWith('{'),
    );
    expect(JSON.parse(jsonCall?.args[0] as string)).toMatchObject({
      exitCode: 1,
      errors: [{ kind: 'scannerExecution', message: 'Binary CDN unavailable' }],
    });
  });

  it('logs redacted launch failures to debug and returns a clean error report', async () => {
    const { console, ctx } = makeContext('secret-tok');
    spyOn(installer, 'installContainerScanner').mockResolvedValue('/bin/sonar-container-scanner');
    spyOn(runner, 'runContainerScanner').mockRejectedValue(
      new Error('spawn EACCES with secret-tok'),
    );
    const debugSpy = spyOn(logger, 'debug').mockImplementation(() => {});

    await analyzeContainer(IMAGE, DEFAULT_OPTIONS, ctx);

    expect(process.exitCode).toBe(1);
    expect(console.findCall('error', 'Could not start the container scanner.')).toBeDefined();
    expect(debugSpy).toHaveBeenCalledWith(
      'Could not start the container scanner: spawn EACCES with [redacted]',
    );
    const jsonCall = console.calls.find(
      (c) => c.method === 'print' && typeof c.args[0] === 'string' && c.args[0].startsWith('{'),
    );
    expect(JSON.parse(jsonCall?.args[0] as string)).toMatchObject({
      exitCode: 1,
      errors: [{ kind: 'scannerExecution', message: 'Could not start the container scanner.' }],
    });
  });

  it('renders table cancellation output and preserves signal exit code', async () => {
    const { console, ctx } = makeContext();
    spyOn(installer, 'installContainerScanner').mockResolvedValue('/bin/sonar-container-scanner');
    spyOn(runner, 'runContainerScanner').mockRejectedValue(
      new runner.ContainerScanCancelledError('SIGINT'),
    );

    await analyzeContainer(IMAGE, { ...DEFAULT_OPTIONS, format: 'table' }, ctx);

    expect(process.exitCode).toBe(130);
    expect(console.findCall('error', 'Container scan cancelled.')).toBeDefined();
    expect(console.findCall('print', 'Container scan cancelled.')).toBeDefined();
  });

  it('detects partial scans from raw stderr even when token redaction alters printed stderr', async () => {
    const { console, ctx } = makeContext('skipped');
    spyOn(installer, 'installContainerScanner').mockResolvedValue('/bin/sonar-container-scanner');
    spyOn(runner, 'runContainerScanner').mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        issues: [],
        errors: [],
        configuration: {
          imageInput: IMAGE,
          failOn: 'high',
          timeoutSecs: 300,
          registry: null,
          repository: null,
          tag: null,
        },
        exitCode: 0,
      }),
      stderr: 'WARNING: the backend skipped 1 package(s)\n',
    });

    await analyzeContainer(IMAGE, { ...DEFAULT_OPTIONS, format: 'table' }, ctx);

    expect(process.exitCode).toBe(0);
    expect(console.findCall('print', 'WARNING: the backend [redacted] 1 package(s)')).toBeDefined();
    expect(console.findCall('print', 'No findings in the packages analyzed.')).toBeDefined();
  });

  it('does not corrupt output when token is empty', async () => {
    const { console, ctx } = makeContext('');
    spyOn(installer, 'installContainerScanner').mockResolvedValue('/bin/sonar-container-scanner');
    spyOn(runner, 'runContainerScanner').mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        issues: [],
        errors: [],
        configuration: {
          imageInput: IMAGE,
          failOn: 'high',
          timeoutSecs: 300,
          registry: null,
          repository: null,
          tag: null,
        },
        exitCode: 0,
      }),
      stderr: '',
    });

    await analyzeContainer(IMAGE, DEFAULT_OPTIONS, ctx);

    expect(process.exitCode).toBe(0);
    expect(console.findCall('print', '[redacted]')).toBeUndefined();
  });
});

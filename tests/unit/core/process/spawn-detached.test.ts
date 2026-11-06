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

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { spawnDetachedToLog, spawnProcessWithTimeout } from '@/core/process/process.ts';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

async function waitForLog(path: string, ...expected: string[]): Promise<string> {
  const deadline = Date.now() + 5000;
  let content = '';
  while (Date.now() < deadline) {
    content = readFileSync(path, 'utf8');
    if (expected.every((text) => content.includes(text))) return content;
    await Bun.sleep(20);
  }
  return content;
}

posixOnly('spawnProcessWithTimeout output callbacks', () => {
  it('hands each decoded chunk to the callbacks and still captures the output', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await spawnProcessWithTimeout(
      'sh',
      ['-c', 'echo to-out; echo to-err >&2'],
      {
        onStdout: (text) => stdout.push(text),
        onStderr: (text) => stderr.push(text),
      },
      5000,
      'timed out',
    );

    expect(stdout.join('')).toBe('to-out\n');
    expect(stderr.join('')).toBe('to-err\n');
    expect(result.stdout).toBe('to-out\n');
    expect(result.stderr).toBe('to-err\n');
  });
});

posixOnly('spawnDetachedToLog', () => {
  let directory: string;
  let pid: number | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'spawn-detached-test-'));
    pid = undefined;
  });

  afterEach(() => {
    if (pid !== undefined) {
      try {
        process.kill(pid);
      } catch {
        // The child has already exited.
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps a child that stays up running, with its output in an owner-only log', async () => {
    const logPath = join(directory, 'child.log');

    pid = await spawnDetachedToLog(
      'sh',
      ['-c', 'echo "$GREETING from $(pwd)"; echo to-err >&2; sleep 5'],
      { logPath, cwd: directory, env: { GREETING: 'hello' } },
    );

    expect(pid).toBeGreaterThan(0);
    const content = await waitForLog(logPath, 'hello from', 'to-err');
    expect(content).toContain('hello from');
    expect(content).toContain('to-err');
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it('reports a child that exits at once instead of announcing it as started', async () => {
    const logPath = join(directory, 'short.log');

    const error = await spawnDetachedToLog('sh', ['-c', 'exit 3'], { logPath }).catch(
      (cause: unknown) => cause,
    );

    expect((error as Error).message).toBe('The process exited at once (code 3).');
  });

  it('rejects when the command cannot be started', async () => {
    const logPath = join(directory, 'missing.log');

    const error = await spawnDetachedToLog(join(directory, 'does-not-exist'), [], {
      logPath,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
  });
});

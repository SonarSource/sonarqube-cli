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

// Dispose diagnostics for Windows afterEach hangs. Quiet when teardown is fast;
// logs the current phase every second, swallowed session/server-stop errors, and
// every fs.rm failure (path, errno, leftover files, processes whose image/command
// line still points at the temp dir).

import { readdir, rm } from 'node:fs/promises';

import { IS_WINDOWS } from './platform';

const WATCHDOG_MS = 1_000;
const HOLDERS_TIMEOUT_MS = 1_500;
const REMAINING_FILE_CAP = 20;

export function startDisposeTrace(tempDir: string): DisposeTrace {
  return new DisposeTrace(tempDir);
}

export class DisposeTrace {
  private readonly startedAt = Date.now();
  private currentPhase = 'start';
  private readonly watchdog: ReturnType<typeof setInterval>;

  constructor(private readonly tempDir: string) {
    this.watchdog = setInterval(() => {
      this.log(`still in ${this.currentPhase} after ${this.elapsed()}ms`);
    }, WATCHDOG_MS);
    this.watchdog.unref();
  }

  async phase<T>(name: string, work: () => Promise<T>): Promise<T> {
    this.currentPhase = name;
    const phaseStarted = Date.now();
    try {
      return await work();
    } finally {
      const ms = Date.now() - phaseStarted;
      if (ms >= WATCHDOG_MS) {
        this.log(`phase ${name} finished in ${ms}ms`);
      }
    }
  }

  stop(): void {
    clearInterval(this.watchdog);
  }

  log(message: string): void {
    process.stderr.write(
      `[harness.dispose +${this.elapsed()}ms] ${message} path=${this.tempDir}\n`,
    );
  }

  swallow(label: string): (err: unknown) => undefined {
    return (err) => {
      this.log(`swallowed ${label}: ${formatError(err)}`);
      return undefined;
    };
  }

  private elapsed(): number {
    return Date.now() - this.startedAt;
  }
}

export async function rmTempDirTraced(trace: DisposeTrace, tempDir: string): Promise<void> {
  const maxRetries = IS_WINDOWS ? 15 : 5;
  const retryDelay = IS_WINDOWS ? 200 : 100;
  let dumpedHolders = false;

  for (let attempt = 0; ; attempt++) {
    try {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 0 });
      if (attempt > 0) {
        trace.log(`rm ok on attempt ${attempt + 1}`);
      }
      return;
    } catch (err) {
      trace.log(`rm fail attempt=${attempt + 1}/${maxRetries + 1} ${formatError(err)}`);
      const remaining = await listRemaining(tempDir);
      if (remaining.length > 0) {
        trace.log(
          `remaining (${remaining.length}): ${remaining.slice(0, REMAINING_FILE_CAP).join(' | ')}`,
        );
      }
      if (IS_WINDOWS && !dumpedHolders) {
        dumpedHolders = true;
        trace.log(`holders: ${await windowsHolders(tempDir)}`);
      }
      if (attempt >= maxRetries) {
        return;
      }
      await delay(retryDelay * (attempt + 1));
    }
  }
}

function formatError(err: unknown): string {
  if (err && typeof err === 'object') {
    const { code, message, path } = err as { code?: string; message?: string; path?: string };
    return `code=${code ?? '?'} path=${path ?? '?'} ${message ?? ''}`;
  }
  return String(err);
}

async function listRemaining(root: string): Promise<string[]> {
  try {
    return await readdir(root, { recursive: true });
  } catch (err) {
    return [`<list failed: ${formatError(err)}>`];
  }
}

async function windowsHolders(tempDir: string): Promise<string> {
  try {
    const proc = Bun.spawn(
      [
        'powershell',
        '-NoProfile',
        '-Command',
        [
          'Get-CimInstance Win32_Process |',
          'Where-Object {',
          '  ($_.ExecutablePath -and $_.ExecutablePath.Contains($env:HARNESS_TEMP)) -or',
          '  ($_.CommandLine -and $_.CommandLine.Contains($env:HARNESS_TEMP))',
          '} |',
          'ForEach-Object { "{0} {1} exe={2} cmd={3}" -f $_.ProcessId, $_.Name, $_.ExecutablePath, $_.CommandLine }',
        ].join(' '),
      ],
      {
        env: { ...process.env, HARNESS_TEMP: tempDir },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const timeout = setTimeout(() => proc.kill(), HOLDERS_TIMEOUT_MS);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const body = stdout.trim();
      if (body.length > 0) {
        return body.replaceAll('\n', ' || ');
      }
      if (exitCode !== 0) {
        return `<empty exit=${exitCode} stderr=${stderr.trim() || 'none'}>`;
      }
      return '<none with ExecutablePath/CommandLine in temp dir>';
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return `<holders failed: ${err instanceof Error ? err.message : String(err)}>`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

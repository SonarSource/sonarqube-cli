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

// Process management helpers

import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';

export type StdioMode = 'pipe' | 'ignore' | 'inherit';

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: StdioMode;
  /** An iterable is pulled one chunk at a time, so a large input is never held whole. */
  stdinData?: string | Buffer | AsyncIterable<Buffer>;
  stdout?: StdioMode;
  stderr?: StdioMode;
  detached?: boolean;
  /** Called immediately after the child process spawns, with a function to kill it. */
  onSpawn?: (kill: () => void) => void;
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function feedStdin(
  stdin: Writable,
  options: SpawnOptions,
  onWriteFailed: (err: Error) => void,
  killChild: () => void,
): void {
  if (options.stdinData === undefined) return;
  if (typeof options.stdinData === 'string' || Buffer.isBuffer(options.stdinData)) {
    stdin.write(options.stdinData);
    stdin.end();
    return;
  }
  // pipeline honours backpressure and ends the stream once the iterable does. EPIPE is reported through
  // the stdin 'error' listener instead, so the exit code carries that failure rather than a rejection.
  void pipeline(options.stdinData, stdin).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
    killChild();
    onWriteFailed(err as Error);
  });
}

/**
 * Spawn process and wait for completion
 */
export async function spawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.stdin || 'ignore', options.stdout || 'pipe', options.stderr || 'pipe'],
      detached: options.detached || false,
    });
    options.onSpawn?.(() => proc.kill());

    let stdout = '';
    let stderr = '';
    let stdinBroken = false;
    // A character's bytes can straddle two chunks, so the decoder holds the remainder until the next one arrives.
    const stdoutDecoder = new StringDecoder('utf-8');
    const stderrDecoder = new StringDecoder('utf-8');

    if (proc.stdout) {
      proc.stdout.on('data', (data: Buffer) => {
        stdout += stdoutDecoder.write(data);
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        stderr += stderrDecoder.write(data);
      });
    }

    if (proc.stdin) {
      // A child that exits before reading its input breaks the pipe; the exit code reports that better than throwing does.
      proc.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE') {
          stdinBroken = true;
        } else {
          reject(error);
        }
      });
      feedStdin(proc.stdin, options, reject, () => proc.kill());
    }

    proc.on('error', reject);

    proc.on('close', (code) => {
      resolve({
        exitCode: stdinBroken ? code || 1 : code,
        stdout: (stdout + stdoutDecoder.end()).trim(),
        stderr: (stderr + stderrDecoder.end()).trim(),
      });
    });
  });
}

/**
 * Spawn process and reject with `timeoutMessage` if it does not finish within `timeoutMs`.
 * Kills the child on timeout.
 */
export async function spawnProcessWithTimeout(
  command: string,
  args: string[],
  options: SpawnOptions,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<SpawnResult> {
  let killChild: (() => void) | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      spawnProcess(command, args, {
        ...options,
        onSpawn: (kill) => {
          killChild = kill;
          options.onSpawn?.(kill);
        },
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          killChild?.();
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}
export interface BytesSpawnResult {
  exitCode: number | null;
  /** Raw stdout. Untrimmed and undecoded, so it can carry arbitrary bytes. */
  stdout: Buffer;
  stderr: string;
}

/** Like {@link spawnProcess}, but keeps stdout as bytes for output that is not text. */
export async function spawnProcessCapturingBytes(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<BytesSpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.stdin ?? 'ignore', options.stdout ?? 'pipe', options.stderr ?? 'pipe'],
    });

    const stdout: Buffer[] = [];
    let stderr = '';
    const stderrDecoder = new StringDecoder('utf-8');
    proc.stdout?.on('data', (data: Buffer) => {
      stdout.push(data);
    });
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += stderrDecoder.write(data);
    });

    if (proc.stdin) {
      proc.stdin.on('error', () => undefined);
      feedStdin(proc.stdin, options, reject, () => proc.kill());
    }

    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout),
        stderr: (stderr + stderrDecoder.end()).trim(),
      });
    });
  });
}

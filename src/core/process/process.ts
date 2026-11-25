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

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { win32 } from 'node:path';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';

import { OWNER_ONLY_FILE_MODE } from '@/core/config-constants.ts';

export type StdioMode = 'pipe' | 'ignore' | 'inherit';

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: StdioMode;
  /** An iterable is pulled one chunk at a time, so a large input is never held whole. */
  stdinData?: string | Buffer | AsyncIterable<Buffer>;
  stdout?: StdioMode;
  stderr?: StdioMode;
  detached?: boolean;
  /**
   * When true, `env` is the child's whole environment. The default merges `env` over `process.env`.
   * Vortex Context deletes inherited `SONAR_CONTEXT_*` keys, which a merge would put back.
   */
  isolateEnv?: boolean;
  /** Kills the direct child (or its process tree when `killProcessTree` is set) when aborted (including if already aborted on spawn). */
  signal?: AbortSignal;
  /**
   * When true, kills the child's entire process tree on timeout, abort, or stdin failure
   * (process group via `detached: true` on Unix; `taskkill /T /F` on Windows).
   */
  killProcessTree?: boolean;
  /** Receives each decoded stdout chunk as it arrives, in addition to the captured `stdout`. */
  onStdout?: (text: string) => void;
  /** Receives each decoded stderr chunk as it arrives, in addition to the captured `stderr`. */
  onStderr?: (text: string) => void;
}

type KillFn = (signal?: NodeJS.Signals) => void;

interface ChildControl {
  kill: KillFn;
  isTreeAlive: () => boolean;
}

interface InternalSpawnOptions extends SpawnOptions {
  /** Internal hook used by {@link raceWithTimeout} to control the child on deadline or abort. */
  onSpawn?: (control: ChildControl) => void;
  stopChild: () => void;
}

/** A child did not finish before its deadline. Distinct from "the program is not installed". */
export class ProcessTimedOutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessTimedOutError';
  }
}

function childEnv(options: SpawnOptions): NodeJS.ProcessEnv {
  if (options.isolateEnv) {
    return options.env ?? {};
  }
  return { ...process.env, ...options.env };
}

function shouldSpawnDetached(options: SpawnOptions): boolean {
  return (
    Boolean(options.detached) || (Boolean(options.killProcessTree) && process.platform !== 'win32')
  );
}

const TREE_CLOSE_GRACE_MS = 1000;
const TREE_KILL_GRACE_MS = 500;
const TREE_POLL_MS = 25;
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function terminateChild(
  proc: ChildProcess,
  killProcessTree: boolean,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (!killProcessTree || proc.pid === undefined) {
    proc.kill(signal);
    return;
  }
  if (process.platform === 'win32') {
    const taskkillPath = win32.join(
      process.env.SystemRoot ?? String.raw`C:\Windows`,
      'System32',
      'taskkill.exe',
    );
    try {
      const result = spawnSync(taskkillPath, ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
      if (result.error || result.status !== 0) {
        proc.kill();
      }
    } catch {
      proc.kill();
    }
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    proc.kill(signal);
  }
}

function isProcessGroupAlive(pid: number | undefined, killProcessTree: boolean): boolean {
  if (!killProcessTree || process.platform === 'win32' || pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

let activeSignalForwarders = 0;

function reRaiseSignal(signal: NodeJS.Signals, cleanup: () => void): void {
  cleanup();
  if (process.listenerCount(signal) === 0) {
    process.kill(process.pid, signal);
  }
}

function attachProcessSignalForwarding(
  stopChild: (signal: NodeJS.Signals) => void,
  getTermination: () => Promise<void> | undefined,
  forceKill: () => void,
  killProcessTree: boolean,
): () => void {
  if (!killProcessTree || process.platform === 'win32') return () => undefined;

  let cleanedUp = false;
  let terminating = false;
  let reRaised = false;
  const onExit = (): void => {
    stopChild('SIGTERM');
  };
  const finishSignal = (signal: NodeJS.Signals): void => {
    if (reRaised) return;
    reRaised = true;
    reRaiseSignal(signal, cleanup);
  };
  const listeners = FORWARDED_SIGNALS.map((signal) => {
    const listener = (): void => {
      if (terminating) {
        forceKill();
        finishSignal(signal);
        return;
      }
      const hasCallerHandler = process.listenerCount(signal) > activeSignalForwarders;
      stopChild(signal);
      if (hasCallerHandler) {
        cleanup();
        return;
      }
      terminating = true;
      void Promise.resolve(getTermination()).finally(() => {
        finishSignal(signal);
      });
    };
    process.on(signal, listener);
    return [signal, listener] as const;
  });
  activeSignalForwarders++;
  process.on('exit', onExit);

  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    activeSignalForwarders--;
    process.off('exit', onExit);
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
  }
  return cleanup;
}

function createChildControl(proc: ChildProcess, options: SpawnOptions): ChildControl {
  const killProcessTree = Boolean(options.killProcessTree);
  return {
    kill: (sig) => {
      terminateChild(proc, killProcessTree, sig);
    },
    isTreeAlive: () => isProcessGroupAlive(proc.pid, killProcessTree),
  };
}

function waitBounded(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    void promise.then(done, done);
  });
}

function waitForGroupExit(isTreeAlive: () => boolean, remainingMs: number): Promise<boolean> {
  if (!isTreeAlive()) return Promise.resolve(true);
  if (remainingMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const deadline = Date.now() + remainingMs;
    const timer = setInterval(() => {
      if (!isTreeAlive()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve(false);
      }
    }, TREE_POLL_MS);
  });
}

async function waitForTreeExit(
  childPromise: Promise<unknown>,
  isTreeAlive: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const childClosed = await waitBounded(childPromise, timeoutMs);
  if (!childClosed) return false;
  return waitForGroupExit(isTreeAlive, deadline - Date.now());
}

async function finishTreeTermination(
  childPromise: Promise<unknown>,
  control: ChildControl | undefined,
): Promise<void> {
  const isTreeAlive = control?.isTreeAlive ?? (() => false);
  const exited = await waitForTreeExit(childPromise, isTreeAlive, TREE_CLOSE_GRACE_MS);
  if (!exited && process.platform !== 'win32') {
    control?.kill('SIGKILL');
    await waitForTreeExit(childPromise, isTreeAlive, TREE_KILL_GRACE_MS);
  }
}

async function raceWithTimeout<T>(
  run: (registerControl: (control: ChildControl) => void, stopChild: () => void) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  { signal, killProcessTree }: Pick<SpawnOptions, 'signal' | 'killProcessTree'>,
): Promise<T> {
  let control: ChildControl | undefined;
  let stopping = false;
  let termination: Promise<void> | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const aborted = Promise.withResolvers<never>();

  function stopChild(termSignal: NodeJS.Signals = 'SIGTERM'): void {
    if (!control || stopping) return;
    stopping = true;
    control.kill(termSignal);
    if (killProcessTree) {
      // A pre-aborted signal can stop the child during spawn, before childPromise is assigned.
      termination = Promise.resolve().then(() => finishTreeTermination(childPromise, control));
    }
  }

  function onAbort(): void {
    stopChild();
    // Preserve the child's result when its pipes close during cleanup.
    if (termination) {
      void termination.then(() => {
        aborted.reject(signal?.reason);
      }, aborted.reject);
    }
  }

  const cleanupForwarding = attachProcessSignalForwarding(
    stopChild,
    () => termination,
    () => control?.kill('SIGKILL'),
    Boolean(killProcessTree),
  );
  signal?.addEventListener('abort', onAbort, { once: true });
  const childPromise = run((nextControl) => {
    control = nextControl;
    if (signal?.aborted) onAbort();
  }, stopChild);

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new ProcessTimedOutError(timeoutMessage));
      stopChild();
    }, timeoutMs);
  });

  try {
    return await Promise.race([childPromise, timeoutPromise, aborted.promise]);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
    try {
      await termination;
    } finally {
      cleanupForwarding();
    }
  }
}

export interface SpawnResult {
  exitCode: number | null;
  /** The signal that killed the child, or null when it exited with a code. */
  signal?: NodeJS.Signals | null;
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
 * Spawn a process and wait until its pipes close.
 * Not exported: every caller goes through {@link spawnProcessWithTimeout} so a child cannot run forever.
 */
async function spawnProcess(
  command: string,
  args: string[],
  options: InternalSpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: childEnv(options),
      stdio: [options.stdin || 'ignore', options.stdout || 'pipe', options.stderr || 'pipe'],
      detached: shouldSpawnDetached(options),
    });
    const control = createChildControl(proc, options);
    options.onSpawn?.(control);

    let stdout = '';
    let stderr = '';
    let stdinBroken = false;
    // A character's bytes can straddle two chunks, so the decoder holds the remainder until the next one arrives.
    const stdoutDecoder = new StringDecoder('utf-8');
    const stderrDecoder = new StringDecoder('utf-8');

    if (proc.stdout) {
      proc.stdout.on('data', (data: Buffer) => {
        const text = stdoutDecoder.write(data);
        stdout += text;
        options.onStdout?.(text);
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (data: Buffer) => {
        const text = stderrDecoder.write(data);
        stderr += text;
        options.onStderr?.(text);
      });
    }

    if (proc.stdin) {
      // A child that exits before reading its input breaks the pipe; the exit code reports that better than throwing does.
      proc.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE') {
          stdinBroken = true;
        } else {
          if (options.killProcessTree) options.stopChild();
          reject(error);
        }
      });
      feedStdin(proc.stdin, options, reject, options.stopChild);
    }

    proc.on('error', reject);

    // 'exit' can run before the last stdout chunk is delivered, so a fast child looks like it produced nothing.
    proc.on('close', (code, signal) => {
      resolve({
        exitCode: stdinBroken ? code || 1 : code,
        signal: signal ?? null,
        stdout: stdout + stdoutDecoder.end(),
        stderr: stderr + stderrDecoder.end(),
      });
    });
  });
}

/**
 * Spawn a process and reject with {@link ProcessTimedOutError} if it does not finish within `timeoutMs`.
 * Kills the direct child (or its process tree when `options.killProcessTree` is set) on timeout.
 */
export async function spawnProcessWithTimeout(
  command: string,
  args: string[],
  options: SpawnOptions,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<SpawnResult> {
  return raceWithTimeout(
    (onSpawn, stopChild) => spawnProcess(command, args, { ...options, onSpawn, stopChild }),
    timeoutMs,
    timeoutMessage,
    options,
  );
}
export interface BytesSpawnResult {
  exitCode: number | null;
  /** Raw stdout. Untrimmed and undecoded, so it can carry arbitrary bytes. */
  stdout: Buffer;
  stderr: string;
}

/** Like {@link spawnProcessWithTimeout}, but keeps stdout as bytes for output that is not text. */
export async function spawnProcessCapturingBytes(
  command: string,
  args: string[],
  options: SpawnOptions,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<BytesSpawnResult> {
  return raceWithTimeout(
    (onSpawn, stopChild) => captureProcessBytes(command, args, { ...options, onSpawn, stopChild }),
    timeoutMs,
    timeoutMessage,
    options,
  );
}

async function captureProcessBytes(
  command: string,
  args: string[],
  options: InternalSpawnOptions,
): Promise<BytesSpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: childEnv(options),
      stdio: [options.stdin ?? 'ignore', options.stdout ?? 'pipe', options.stderr ?? 'pipe'],
      detached: shouldSpawnDetached(options),
    });
    const control = createChildControl(proc, options);
    options.onSpawn?.(control);

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
      proc.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (options.killProcessTree && error.code !== 'EPIPE') {
          options.stopChild();
          reject(error);
        }
      });
      feedStdin(proc.stdin, options, reject, options.stopChild);
    }

    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout),
        stderr: stderr + stderrDecoder.end(),
      });
    });
  });
}

const DETACHED_EARLY_EXIT_MS = 1500;

/**
 * Starts a child that outlives this process, with stdout and stderr appended to `logPath`.
 * Resolves to its pid once it has stayed up briefly, so a child that dies at once (bad classpath,
 * missing runtime) is reported instead of being announced as started. Nothing waits for it after.
 */
export async function spawnDetachedToLog(
  command: string,
  args: string[],
  options: Pick<SpawnOptions, 'cwd' | 'env'> & { logPath: string },
): Promise<number> {
  const logFd = openSync(options.logPath, 'a', OWNER_ONLY_FILE_MODE);
  try {
    return await new Promise<number>((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd: options.cwd,
        env: childEnv(options),
        stdio: ['ignore', logFd, logFd],
        detached: true,
        windowsHide: true,
      });
      proc.once('error', reject);
      proc.once('spawn', () => {
        const pid = proc.pid;
        if (pid === undefined) {
          reject(new Error('The process has no pid.'));
          return;
        }
        const settle = setTimeout(() => {
          proc.removeAllListeners('exit');
          proc.unref();
          resolve(pid);
        }, DETACHED_EARLY_EXIT_MS);
        proc.once('exit', (code, signal) => {
          clearTimeout(settle);
          const reason = signal ?? `code ${code}`;
          reject(new Error(`The process exited at once (${reason}).`));
        });
      });
    });
  } finally {
    closeSync(logFd);
  }
}

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

// Interactive CLI session — wait for prompt text, type, then waitFinish or kill

import { DEFAULT_CLI_TIMEOUT_MS, spawnCliProcess, tryDeliverToken } from './cli-runner.js';
import type { CliResult, InteractiveProcessHandle, SessionStdin } from './types.js';

export type { InteractiveProcessHandle, SessionStdin } from './types.js';

const ENTER = '\r';
const CTRL_C = '\x03';
const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const SPACE = ' ';

export type PromptText = string | RegExp;

export type InteractiveSessionOptions = {
  timeoutMs?: number;
  waitTimeoutMs?: number;
  startedAt?: number;
  browserToken?: string;
  browserTokenName?: string;
};

/** CSI / OSC / leftover ESC plus CR, so clack cursor codes do not hide prompt text. */
const CONTROL_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b.|[\r]/g;

export function stripControlSequences(s: string): string {
  return s.replaceAll(CONTROL_SEQUENCE, '');
}

export function formatPrompt(prompt: PromptText): string {
  return typeof prompt === 'string' ? `"${prompt}"` : String(prompt);
}

/** Clack paints a submitted prompt (and `discreetSuccess`) as `  ✓  …`; such a line is never a live wait target. */
const SUBMITTED_PROMPT_PREFIX = '✓  ';
const LIVE_PROMPT_PREFIX = '?  ';

function isSubmittedPrompt(window: string, matchIndex: number): boolean {
  const lineStart = window.lastIndexOf('\n', matchIndex) + 1;
  const prefix = window.slice(lineStart, matchIndex);
  const submittedAt = prefix.lastIndexOf(SUBMITTED_PROMPT_PREFIX);
  const liveAt = prefix.lastIndexOf(LIVE_PROMPT_PREFIX);
  if (submittedAt === -1) {
    return prefix.trimStart().startsWith(SUBMITTED_PROMPT_PREFIX);
  }
  return submittedAt > liveAt;
}

/** Raw index at `rawStart` plus enough bytes for `strippedCount` visible characters. */
export function rawOffsetAfterStripped(
  raw: string,
  rawStart: number,
  strippedCount: number,
): number {
  if (strippedCount <= 0) {
    return rawStart;
  }
  for (let rawEnd = rawStart + 1; rawEnd <= raw.length; rawEnd++) {
    if (stripControlSequences(raw.slice(rawStart, rawEnd)).length >= strippedCount) {
      return rawEnd;
    }
  }
  return raw.length;
}

export function findPromptMatch(window: string, prompt: PromptText): number | null {
  if (typeof prompt === 'string') {
    let searchFrom = 0;
    while (searchFrom <= window.length) {
      const index = window.indexOf(prompt, searchFrom);
      if (index === -1) {
        return null;
      }
      if (!isSubmittedPrompt(window, index)) {
        return index + prompt.length;
      }
      searchFrom = index + prompt.length;
    }
    return null;
  }
  const flags = prompt.flags.replaceAll('g', '').replaceAll('y', '');
  const matcher = new RegExp(prompt.source, `${flags}g`);
  for (let match = matcher.exec(window); match !== null; match = matcher.exec(window)) {
    if (!isSubmittedPrompt(window, match.index)) {
      return match.index + match[0].length;
    }
    matcher.lastIndex = match.index + Math.max(match[0].length, 1);
  }
  return null;
}

export function startInteractiveSession(
  command: string,
  env: Record<string, string>,
  options: {
    cwd: string;
    timeoutMs?: number;
    waitTimeoutMs?: number;
    binaryPath?: string;
    browserToken?: string;
    browserTokenName?: string;
  },
): InteractiveSession {
  const spawned = spawnCliProcess(command, env, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    binaryPath: options.binaryPath,
    stdin: 'pipe',
  });
  return InteractiveSession.fromProcess(spawned.proc, {
    timeoutMs: spawned.timeoutMs,
    startedAt: spawned.startedAt,
    waitTimeoutMs: options.waitTimeoutMs,
    browserToken: options.browserToken,
    browserTokenName: options.browserTokenName,
  });
}

export class InteractiveSession {
  private readonly proc: InteractiveProcessHandle;
  private readonly timeoutMs: number;
  private readonly waitTimeoutMs: number;
  private readonly startedAt: number;
  private readonly browserToken?: string;
  private readonly browserTokenName?: string;
  private readonly encoder = new TextEncoder();
  private readonly waiters: Array<() => void> = [];
  private readersDone!: Promise<void>;
  private timer!: ReturnType<typeof setTimeout>;

  private rawStdout = '';
  private rawStderr = '';
  /** Byte offset into `rawStdout` (monotonic — that buffer only grows). */
  private consumed = 0;
  /** Raw-stdout offset at the last write; next waitText ignores output already on screen. */
  private barrier = 0;
  private tokenDelivered = false;
  private stdinEnded = false;
  private killed = false;
  private timedOut = false;
  private exitCode: number | undefined;
  private resultPromise: Promise<CliResult> | undefined;

  static fromProcess(
    proc: InteractiveProcessHandle,
    options: InteractiveSessionOptions = {},
  ): InteractiveSession {
    const session = new InteractiveSession(proc, options);
    session.start();
    return session;
  }

  private constructor(proc: InteractiveProcessHandle, options: InteractiveSessionOptions) {
    this.proc = proc;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    this.waitTimeoutMs = options.waitTimeoutMs ?? this.timeoutMs;
    this.startedAt = options.startedAt ?? Date.now();
    this.browserToken = options.browserToken;
    this.browserTokenName = options.browserTokenName;
  }

  private start(): void {
    this.readersDone = Promise.all([
      this.consume(this.proc.stdout, (chunk) => {
        this.rawStdout += chunk;
        if (this.browserToken && !this.tokenDelivered) {
          this.tokenDelivered = tryDeliverToken(
            this.rawStdout,
            this.browserToken,
            this.browserTokenName,
          );
        }
        this.notify();
      }),
      this.consume(this.proc.stderr, (chunk) => {
        this.rawStderr += chunk;
        this.notify();
      }),
    ]).then(() => undefined);

    void this.proc.exited.then((code) => {
      this.exitCode = code;
      clearTimeout(this.timer);
      this.notify();
    });

    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.kill();
    }, this.timeoutMs);
  }

  async waitText(prompt: PromptText, timeoutMs = this.waitTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const rawStart = Math.max(this.consumed, this.barrier);
      const window = stripControlSequences(this.rawStdout.slice(rawStart));
      const matchEnd = findPromptMatch(window, prompt);
      if (matchEnd !== null) {
        this.consumed = rawOffsetAfterStripped(this.rawStdout, rawStart, matchEnd);
        return;
      }
      if (this.timedOut) {
        throw this.waitError(`CLI process timed out after ${this.timeoutMs}ms waiting for`, prompt);
      }
      if (this.exitCode !== undefined) {
        throw this.waitError('CLI exited before', prompt, 'appeared');
      }
      if (Date.now() >= deadline) {
        throw this.waitError('Timed out waiting for', prompt);
      }
      await this.waitUntilChange(deadline);
    }
  }

  write(keys: string): void {
    const stdin = this.assertWritable();
    this.barrier = this.rawStdout.length;
    stdin.write(this.encoder.encode(keys));
  }

  keyEnter(): void {
    this.write(ENTER);
  }

  keyUp(): void {
    this.write(ARROW_UP);
  }

  keyDown(): void {
    this.write(ARROW_DOWN);
  }

  keySpace(): void {
    this.write(SPACE);
  }

  keyCtrlC(): void {
    this.write(CTRL_C);
  }

  output(): string {
    return stripControlSequences(this.rawStdout + this.rawStderr);
  }

  async waitFinish(): Promise<CliResult> {
    this.resultPromise ??= this.collectResult();
    return this.resultPromise;
  }

  kill(): void {
    if (this.killed) {
      return;
    }
    this.killed = true;
    clearTimeout(this.timer);
    try {
      this.proc.kill();
    } catch {
      /* process may already have exited */
    }
    this.endStdin();
  }

  private async collectResult(): Promise<CliResult> {
    this.endStdin();
    const [exitCode] = await Promise.all([this.proc.exited, this.readersDone]);
    clearTimeout(this.timer);
    if (this.timedOut) {
      throw new Error(`CLI process timed out after ${this.timeoutMs}ms`);
    }
    return {
      exitCode,
      stdout: this.rawStdout,
      stderr: this.rawStderr,
      durationMs: Date.now() - this.startedAt,
    };
  }

  private assertWritable(): SessionStdin {
    if (this.exitCode !== undefined) {
      throw new Error('Cannot write to an interactive session that has already exited');
    }
    if (this.timedOut) {
      throw new Error(
        `Cannot write to an interactive session killed by the ${this.timeoutMs}ms timeout`,
      );
    }
    if (this.killed) {
      throw new Error('Cannot write to an interactive session after kill()');
    }
    if (this.stdinEnded || !this.proc.stdin) {
      throw new Error('Cannot write to an interactive session after waitFinish()');
    }
    return this.proc.stdin;
  }

  private endStdin(): void {
    if (this.stdinEnded) {
      return;
    }
    this.stdinEnded = true;
    try {
      this.proc.stdin?.end();
    } catch {
      /* stdin may already be closed */
    }
  }

  private waitError(prefix: string, prompt: PromptText, suffix = ''): Error {
    const after = suffix === '' ? '' : ` ${suffix}`;
    return new Error(
      `${prefix} ${formatPrompt(prompt)}${after} on stdout\n--- stdout ---\n${stripControlSequences(this.rawStdout)}\n--- stderr ---\n${stripControlSequences(this.rawStderr)}`,
    );
  }

  private notify(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private waitUntilChange(deadlineMs: number): Promise<void> {
    if (this.exitCode !== undefined || this.timedOut) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          const index = this.waiters.indexOf(onChange);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          resolve();
        },
        Math.max(0, deadlineMs - Date.now()),
      );
      const onChange = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(onChange);
    });
  }

  private async consume(
    stream: ReadableStream<Uint8Array>,
    onChunk: (text: string) => void,
  ): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        onChunk(decoder.decode(value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) {
        onChunk(tail);
      }
    } finally {
      reader.releaseLock();
    }
  }
}

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

// Interactive CLI session — wait for prompt text, type, then finish or kill

import { DEFAULT_CLI_TIMEOUT_MS, spawnCliProcess, tryDeliverToken } from './cli-runner.js';
import type { CliResult, InteractiveProcessHandle, SessionStdin } from './types.js';

export type { InteractiveProcessHandle, SessionStdin } from './types.js';

const ENTER = '\r';
const CTRL_C = '\x03';

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

export function findPromptMatch(window: string, prompt: PromptText): number | null {
  if (typeof prompt === 'string') {
    const index = window.indexOf(prompt);
    return index === -1 ? null : index + prompt.length;
  }
  const flags = prompt.flags.replaceAll('g', '').replaceAll('y', '');
  const match = window.match(new RegExp(prompt.source, flags));
  if (!match || match.index === undefined) {
    return null;
  }
  return match.index + match[0].length;
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
  private readonly readersDone: Promise<void>;
  private readonly timer: ReturnType<typeof setTimeout>;

  private rawStdout = '';
  private rawStderr = '';
  private consumed = 0;
  /** Output already on screen when the last write happened; next waitText ignores it (clack echoes). */
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
    return new InteractiveSession(proc, options);
  }

  private constructor(proc: InteractiveProcessHandle, options: InteractiveSessionOptions) {
    this.proc = proc;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    this.waitTimeoutMs = options.waitTimeoutMs ?? this.timeoutMs;
    this.startedAt = options.startedAt ?? Date.now();
    this.browserToken = options.browserToken;
    this.browserTokenName = options.browserTokenName;

    this.readersDone = Promise.all([
      this.consume(proc.stdout, (chunk) => {
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
      this.consume(proc.stderr, (chunk) => {
        this.rawStderr += chunk;
        this.notify();
      }),
    ]).then(() => undefined);

    void proc.exited.then((code) => {
      this.exitCode = code;
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
      const stripped = stripControlSequences(this.rawStdout);
      const window = stripped.slice(Math.max(this.consumed, this.barrier));
      if (findPromptMatch(window, prompt) !== null) {
        // Consume everything already received so the next wait only sees later output.
        this.consumed = stripped.length;
        return;
      }
      if (this.timedOut) {
        throw new Error(
          `CLI process timed out after ${this.timeoutMs}ms waiting for ${formatPrompt(prompt)}\n${this.output()}`,
        );
      }
      if (this.exitCode !== undefined) {
        throw new Error(`CLI exited before ${formatPrompt(prompt)} appeared\n${this.output()}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${formatPrompt(prompt)}\n${this.output()}`);
      }
      await this.waitUntilChange(deadline);
    }
  }

  write(keys: string): void {
    const stdin = this.assertWritable();
    this.barrier = stripControlSequences(this.rawStdout).length;
    stdin.write(this.encoder.encode(keys));
  }

  enter(): void {
    this.write(ENTER);
  }

  cancel(): void {
    this.write(CTRL_C);
  }

  output(): string {
    return stripControlSequences(this.rawStdout + this.rawStderr);
  }

  async finish(): Promise<CliResult> {
    this.resultPromise ??= this.collectResult();
    return this.resultPromise;
  }

  kill(): void {
    if (this.killed) {
      return;
    }
    this.killed = true;
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
    if (this.stdinEnded || !this.proc.stdin) {
      throw new Error('Cannot write to an interactive session after finish()');
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

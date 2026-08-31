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

// CLI runner — spawns the compiled sonarqube-cli binary and captures output

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { applyIsolatedSpawnEnv } from '../../_common/isolated-cli-env.js';
import { COVERAGE_BINARY, COVERAGE_RAW_DIR } from '../../coverage/paths.js';
import { IS_WINDOWS } from './platform';
import type { CliResult, InteractiveProcessHandle, SessionStdin } from './types.js';

const PROJECT_ROOT = join(import.meta.dir, '../../..');
const DEFAULT_BINARY = join(
  PROJECT_ROOT,
  'dist',
  IS_WINDOWS ? 'sonarqube-cli.exe' : 'sonarqube-cli',
);
export const DEFAULT_CLI_TIMEOUT_MS = 30000;

function getBinaryPath(coverageMode: boolean, overridePath?: string): string {
  const binaryPath = overridePath ?? (coverageMode ? COVERAGE_BINARY : DEFAULT_BINARY);
  if (!existsSync(binaryPath)) {
    throw new Error(
      `CLI binary not found at: ${binaryPath}\n` + `Run 'bun run build:binary' to build it first.`,
    );
  }
  return binaryPath;
}

/** Same executable `runCli` uses (coverage binary when `SONARQUBE_CLI_USE_COVERAGE=1`). */
export function getCliBinaryPath(): string {
  return getBinaryPath(process.env.SONARQUBE_CLI_USE_COVERAGE === '1');
}

const STDIN_CHUNK_DELAY_MS = 300;

export type SpawnedCliProcess = {
  proc: InteractiveProcessHandle;
  timeoutMs: number;
  startedAt: number;
};

export function spawnCliProcess(
  command: string,
  env: Record<string, string>,
  options: {
    cwd: string;
    timeoutMs?: number;
    binaryPath?: string;
    stdin: 'pipe' | 'ignore';
  },
): SpawnedCliProcess {
  const coverageMode = process.env.SONARQUBE_CLI_USE_COVERAGE === '1';
  const binaryPath = getBinaryPath(coverageMode, options.binaryPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const startedAt = Date.now();
  mkdirSync(options.cwd, { recursive: true });

  const spawnEnv = applyIsolatedSpawnEnv(env);
  if (coverageMode) {
    mkdirSync(COVERAGE_RAW_DIR, { recursive: true });
    const unique = `${Date.now()}-${crypto.randomUUID()}`;
    spawnEnv.COVERAGE_OUTPUT_FILE = join(COVERAGE_RAW_DIR, `coverage-${unique}.json`);
  }

  const args = tokenize(command);
  const proc = wrapSpawnedProcess(
    Bun.spawn([binaryPath, ...args], {
      env: spawnEnv,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: options.stdin,
      cwd: options.cwd,
    }),
  );

  return { proc, timeoutMs, startedAt };
}

function wrapSpawnedProcess(proc: ReturnType<typeof Bun.spawn>): InteractiveProcessHandle {
  return {
    stdin: isSessionStdin(proc.stdin) ? proc.stdin : null,
    stdout: requirePipedStream(proc.stdout, 'stdout'),
    stderr: requirePipedStream(proc.stderr, 'stderr'),
    kill() {
      proc.kill();
    },
    get exited() {
      return proc.exited;
    },
  };
}

function isSessionStdin(stdin: unknown): stdin is SessionStdin {
  return typeof stdin === 'object' && stdin !== null && 'write' in stdin && 'end' in stdin;
}

function requirePipedStream(
  stream: number | ReadableStream<Uint8Array> | undefined,
  name: string,
): ReadableStream<Uint8Array> {
  if (typeof stream === 'object' && stream !== null) {
    return stream;
  }
  throw new Error(`Expected piped ${name}`);
}

export async function runCli(
  command: string,
  env: Record<string, string>,
  options: {
    stdin?: string;
    stdinChunks?: string[];
    stdinChunkDelayMs?: number;
    timeoutMs?: number;
    cwd: string;
    browserToken?: string;
    browserTokenName?: string;
    binaryPath?: string;
  },
): Promise<CliResult> {
  const hasStdin = options.stdin !== undefined || (options.stdinChunks?.length ?? 0) > 0;
  const { proc, timeoutMs, startedAt } = spawnCliProcess(command, env, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    binaryPath: options.binaryPath,
    stdin: hasStdin ? 'pipe' : 'ignore',
  });

  if (options.stdin !== undefined && proc.stdin) {
    proc.stdin.write(new TextEncoder().encode(options.stdin));
    proc.stdin.end();
  }

  if (options.stdinChunks !== undefined && proc.stdin) {
    const encoder = new TextEncoder();
    // Write each chunk with a delay so readline in the CLI process finishes
    // handling one prompt before the next chunk arrives for the next prompt.
    const chunkDelayMs = options.stdinChunkDelayMs ?? STDIN_CHUNK_DELAY_MS;
    await (async () => {
      for (const chunk of options.stdinChunks ?? []) {
        await new Promise((r) => setTimeout(r, chunkDelayMs));
        proc.stdin?.write(encoder.encode(chunk));
      }
      proc.stdin?.end();
    })();
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  let stdout: string;

  if (options.browserToken) {
    stdout = await streamStdoutAndDeliverToken(
      proc.stdout,
      options.browserToken,
      options.browserTokenName,
    );
  } else {
    stdout = await new Response(proc.stdout).text();
  }

  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  clearTimeout(timer);

  if (timedOut) {
    throw new Error(`CLI process timed out after ${timeoutMs}ms`);
  }

  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Extracts the loopback port from accumulated stdout and POSTs the token to it.
 * Returns true if the token was delivered, false if the port was not found yet.
 */
export function tryDeliverToken(accumulated: string, token: string, tokenName?: string): boolean {
  const match = /[?&]port=(\d+)/.exec(accumulated);
  if (!match) return false;
  const port = match[1];
  fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, ...(tokenName ? { name: tokenName } : {}) }),
  }).catch(() => {
    /* loopback server may close before response completes */
  });
  return true;
}

/**
 * Reads stdout incrementally. When the loopback auth port appears in the output
 * (pattern: `port=NNNNN`), delivers the token via POST to the loopback server.
 * Returns the full accumulated stdout once the stream ends.
 */
async function streamStdoutAndDeliverToken(
  stream: ReadableStream<Uint8Array>,
  token: string,
  tokenName?: string,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let accumulated = '';
  let tokenDelivered = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      accumulated += decoder.decode(value, { stream: true });

      if (!tokenDelivered) {
        tokenDelivered = tryDeliverToken(accumulated, token, tokenName);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return accumulated;
}

/**
 * Tokenize a command string into an args array.
 * Handles single- and double-quoted strings to support paths with spaces.
 */
function tokenize(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (const char of command) {
    if (inQuote) {
      if (char === quoteChar) {
        inQuote = false;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = true;
      quoteChar = char;
    } else if (char === ' ') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}

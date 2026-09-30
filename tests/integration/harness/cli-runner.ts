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
import type { InteractiveProcessHandle, SessionStdin } from './types.js';

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

/** Same executable the harness spawns (coverage binary when `SONARQUBE_CLI_USE_COVERAGE=1`). */
export function getCliBinaryPath(): string {
  return getBinaryPath(process.env.SONARQUBE_CLI_USE_COVERAGE === '1');
}

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

/**
 * Runs the CLI attached to a real pty via the Unix `script` utility, so `process.stdin.isTTY`
 * is genuinely true in the CLI process — something no other harness method can provide.
 * `run()`/`runInteractive()` always give the child a pipe (`run()` no stdin at all,
 * `runInteractive()` a piped one), never a real terminal.
 *
 * macOS (BSD) and Linux (util-linux) `script` take different arguments, so this branches on
 * `process.platform`. Not supported on Windows, which has no equivalent without extra tooling —
 * callers must guard with `it.skipIf(IS_WINDOWS)`.
 */
export async function runCliWithRealTty(
  command: string,
  env: Record<string, string>,
  options: { cwd: string; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  if (IS_WINDOWS) {
    throw new Error('runCliWithRealTty is not supported on Windows; guard callers with skipIf.');
  }

  const coverageMode = process.env.SONARQUBE_CLI_USE_COVERAGE === '1';
  const binaryPath = getBinaryPath(coverageMode);
  const args = tokenize(command);
  // -e/--return: without it, util-linux `script` always exits 0 on a successful run of the
  // wrapper itself, regardless of the wrapped command's real exit code. BSD (macOS) `script`
  // has no such flag because it never had the problem — it exits with the child's status by
  // default.
  const scriptArgv =
    process.platform === 'darwin'
      ? ['script', '-q', '/dev/null', binaryPath, ...args]
      : ['script', '-qec', shellJoin([binaryPath, ...args]), '/dev/null'];

  const startedAt = Date.now();
  mkdirSync(options.cwd, { recursive: true });
  const spawnEnv = applyIsolatedSpawnEnv(env);
  if (coverageMode) {
    mkdirSync(COVERAGE_RAW_DIR, { recursive: true });
    const unique = `${Date.now()}-${crypto.randomUUID()}`;
    spawnEnv.COVERAGE_OUTPUT_FILE = join(COVERAGE_RAW_DIR, `coverage-${unique}.json`);
  }
  const proc = Bun.spawn(scriptArgv, {
    env: spawnEnv,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    cwd: options.cwd,
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  return { exitCode, stdout, stderr, durationMs: Date.now() - startedAt };
}

/** Quotes each argument for a POSIX shell `-c` string (single-quote, escaping embedded ones). */
function shellJoin(args: string[]): string {
  return args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
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

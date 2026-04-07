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
import { COVERAGE_BINARY, COVERAGE_RAW_DIR } from '../../coverage/paths.js';
import type { CliResult } from './types.js';
import { IS_WINDOWS } from './platform';

const PROJECT_ROOT = join(import.meta.dir, '../../..');
const DEFAULT_BINARY = join(
  PROJECT_ROOT,
  'dist',
  IS_WINDOWS ? 'sonarqube-cli.exe' : 'sonarqube-cli',
);
const DEFAULT_TIMEOUT_MS = 30000;

function getBinaryPath(coverageMode: boolean): string {
  const binaryPath = coverageMode ? COVERAGE_BINARY : DEFAULT_BINARY;
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

export async function runCli(
  command: string,
  env: Record<string, string>,
  options: {
    stdin?: string;
    stdinChunks?: string[];
    timeoutMs?: number;
    cwd: string;
    browserToken?: string;
  },
): Promise<CliResult> {
  const coverageMode = process.env.SONARQUBE_CLI_USE_COVERAGE === '1';
  const binaryPath = getBinaryPath(coverageMode);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();
  mkdirSync(options.cwd, { recursive: true });

  const spawnEnv = { ...env, SONARQUBE_CLI_DISABLE_SENTRY: '1' };
  if (coverageMode) {
    mkdirSync(COVERAGE_RAW_DIR, { recursive: true });
    const unique = `${Date.now()}-${crypto.randomUUID()}`;
    spawnEnv.COVERAGE_OUTPUT_FILE = join(COVERAGE_RAW_DIR, `coverage-${unique}.json`);
  }

  const args = tokenize(command);
  const hasStdin = options.stdin !== undefined || (options.stdinChunks?.length ?? 0) > 0;
  const proc = Bun.spawn([binaryPath, ...args], {
    env: spawnEnv,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: hasStdin ? 'pipe' : 'ignore',
    cwd: options.cwd,
  });

  if (options.stdin !== undefined && proc.stdin) {
    // proc.stdin is a Bun FileSink (not a Web WritableStream)
    const sink = proc.stdin as { write(data: Uint8Array): void; end(): void };
    sink.write(new TextEncoder().encode(options.stdin));
    sink.end();
  }

  if (options.stdinChunks !== undefined && proc.stdin) {
    const sink = proc.stdin as { write(data: Uint8Array): void; end(): void };
    const encoder = new TextEncoder();
    // Write each chunk with a delay so readline in the CLI process finishes
    // handling one prompt before the next chunk arrives for the next prompt.
    await (async () => {
      for (const chunk of options.stdinChunks) {
        await new Promise((r) => setTimeout(r, STDIN_CHUNK_DELAY_MS));
        sink.write(encoder.encode(chunk));
      }
      sink.end();
    })();
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  let stdout: string;

  if (options.browserToken) {
    stdout = await streamStdoutAndDeliverToken(proc.stdout, options.browserToken);
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
    durationMs: Date.now() - startTime,
  };
}

/**
 * Extracts the loopback port from accumulated stdout and POSTs the token to it.
 * Returns true if the token was delivered, false if the port was not found yet.
 */
function tryDeliverToken(accumulated: string, token: string): boolean {
  const match = /[?&]port=(\d+)/.exec(accumulated);
  if (!match) return false;
  const port = match[1];
  fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
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
        tokenDelivered = tryDeliverToken(accumulated, token);
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

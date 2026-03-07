/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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
import type { CliResult } from './types.js';

const PROJECT_ROOT = join(import.meta.dir, '../../..');
const DEFAULT_BINARY = join(PROJECT_ROOT, 'dist', 'sonarqube-cli');
const BINARY_PATH = process.env.SONAR_CLI_BINARY ?? DEFAULT_BINARY;
const DEFAULT_TIMEOUT_MS = 30000;

export function assertBinaryExists(): void {
  if (!existsSync(BINARY_PATH)) {
    throw new Error(
      `CLI binary not found at: ${BINARY_PATH}\n` +
        `Run 'npm run build:binary' to build it first.\n` +
        `Or set SONAR_CLI_BINARY env var to point to a different path.`,
    );
  }
}

export async function runCli(
  command: string,
  env: Record<string, string>,
  options: { stdin?: string; timeoutMs?: number; cwd: string; browserToken?: string },
): Promise<CliResult> {
  assertBinaryExists();

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();
  mkdirSync(options.cwd, { recursive: true });

  const args = tokenize(command);
  const proc = Bun.spawn([BINARY_PATH, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: options.stdin ? 'pipe' : 'ignore',
    cwd: options.cwd,
  });

  if (options.stdin !== undefined && proc.stdin) {
    // proc.stdin is a Bun FileSink (not a Web WritableStream)
    const sink = proc.stdin as { write(data: Uint8Array): void; end(): void };
    sink.write(new TextEncoder().encode(options.stdin));
    sink.end();
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
 * Reads stdout incrementally. When the loopback auth port appears in the output
 * (pattern: `port=NNNNN`), delivers the token via GET to the loopback server.
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
        const match = accumulated.match(/[?&]port=(\d+)/);
        if (match) {
          tokenDelivered = true;
          const port = match[1];
          fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`).catch(() => {
            /* loopback server may close before response completes */
          });
        }
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

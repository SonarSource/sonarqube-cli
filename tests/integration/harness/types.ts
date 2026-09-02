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

// Integration test harness — shared types

export type SessionStdin = {
  write(data: Uint8Array): number | void;
  end(): void;
};

export type InteractiveProcessHandle = {
  stdin: SessionStdin | null;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(): void;
  readonly exited: Promise<number>;
};

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunOptions {
  extraEnv?: Record<string, string>;
  /** Working directory for the CLI process. Defaults to harness.cwd.path. */
  cwd?: string;
  timeoutMs?: number;
  /**
   * When set, the harness streams CLI stdout looking for the loopback OAuth
   * port (pattern: `port=\d+`), then delivers this token via POST request to
   * the loopback server. Use this to test interactive browser-auth flows.
   */
  browserToken?: string;
  browserTokenName?: string;
  /** Override the compiled CLI binary path for this invocation. */
  binaryPath?: string;
}

/** Options for `harness.runInteractive()`. Stdin is driven by the session. */
export type RunInteractiveOptions = RunOptions & {
  /** Per-`waitText` timeout. Defaults to `timeoutMs`. */
  waitTimeoutMs?: number;
};

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: string;
  timestamp: number;
}

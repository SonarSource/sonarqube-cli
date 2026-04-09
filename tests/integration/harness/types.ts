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

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunOptions {
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  /**
   * Writes stdin in separate chunks with a 300 ms delay between each. Use
   * this when the CLI shows multiple sequential interactive prompts: sending
   * all bytes at once causes readline to buffer and discard later bytes before
   * the next prompt has started listening.
   */
  stdinChunks?: string[];
  /**
   * When set, the harness streams CLI stdout looking for the loopback OAuth
   * port (pattern: `port=\d+`), then delivers this token via GET request to
   * the loopback server. Use this to test interactive browser-auth flows.
   */
  browserToken?: string;
}

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  timestamp: number;
}

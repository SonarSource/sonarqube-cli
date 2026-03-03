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

// TestHarness — main entry point for integration tests

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from './cli-runner.js';
import { EnvironmentBuilder } from './environment-builder.js';
import { FileSystemBuilder } from './fs-builder.js';
import { FakeSonarQubeServerBuilder, FakeSonarQubeServer } from './fake-sonarqube-server.js';
import type { CliResult, RunOptions } from './types.js';

export { EnvironmentBuilder } from './environment-builder.js';
export { FileSystemBuilder } from './fs-builder.js';
export {
  FakeSonarQubeServerBuilder,
  FakeSonarQubeServer,
  ProjectBuilder,
} from './fake-sonarqube-server.js';
export type { CliResult, RunOptions, RecordedRequest } from './types.js';

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

export class TestHarness {
  private readonly tempDir: string;
  private readonly servers: FakeSonarQubeServer[] = [];
  private _envBuilder?: EnvironmentBuilder;
  private _extraEnv: Record<string, string> = {};
  private _fsCounter = 0;

  private constructor(tempDir: string) {
    this.tempDir = tempDir;
  }

  static create(): Promise<TestHarness> {
    const tempDir = join(
      tmpdir(),
      `sonar-cli-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    return Promise.resolve(new TestHarness(tempDir));
  }

  /** Absolute path to the isolated temp directory used by this harness instance. */
  get isolatedDir(): string {
    return this.tempDir;
  }

  /**
   * Returns the EnvironmentBuilder for this harness (lazily created, shared instance).
   * Configure it before calling run().
   */
  env(): EnvironmentBuilder {
    if (!this._envBuilder) {
      this._envBuilder = new EnvironmentBuilder();
    }
    return this._envBuilder;
  }

  /**
   * Creates a new FakeSonarQubeServerBuilder. Call .start() on the result to get a
   * running server. The server is stopped automatically when dispose() is called.
   */
  newFakeServer(): FakeSonarQubeServerBuilder & { start: () => Promise<FakeSonarQubeServer> } {
    const builder = new FakeSonarQubeServerBuilder();

    // Wrap start() to register the server for cleanup
    const originalStart = builder.start.bind(builder);
    builder.start = async () => {
      const server = await originalStart();
      this.servers.push(server);
      return server;
    };

    return builder;
  }

  /**
   * Creates a FileSystemBuilder rooted at a unique subdirectory of tempDir.
   */
  newFileSystem(): FileSystemBuilder {
    const subDir = join(this.tempDir, `files-${++this._fsCounter}`);
    return new FileSystemBuilder(subDir);
  }

  /**
   * Adds an extra environment variable that will be passed to all CLI invocations.
   */
  withEnv(key: string, value: string): this {
    this._extraEnv[key] = value;
    return this;
  }

  /**
   * Runs the CLI binary with the given command string.
   *
   * Before spawning, applies the configured environment (writes state.json + copies binary).
   * Automatically injects SONAR_CLI_DIR and SONAR_CLI_DISABLE_KEYCHAIN=true.
   */
  async run(command: string, options?: RunOptions): Promise<CliResult> {
    // Apply environment to tempDir before each run
    if (this._envBuilder) {
      await this._envBuilder.writeTo(this.tempDir);
    }

    // Clean environment — only include the minimum system vars needed to run a binary.
    // This prevents developer-specific env vars (tokens, staging URLs, etc.) from
    // leaking into the CLI process and affecting test behaviour.
    const systemVars: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TERM']) {
      const val = process.env[key];
      if (val !== undefined) systemVars[key] = val;
    }

    const env: Record<string, string> = {
      ...systemVars,
      SONAR_CLI_DIR: this.tempDir,
      SONAR_CLI_KEYCHAIN_FILE: join(this.tempDir, 'keychain.json'),
      CI: 'true',
      ...this._extraEnv,
      ...(options?.extraEnv ?? {}),
    };

    const args = tokenize(command);

    return runCli(args, env, {
      stdin: options?.stdin,
      timeoutMs: options?.timeoutMs,
      cwd: options?.cwd,
      browserToken: options?.browserToken,
    });
  }

  /**
   * Stops all fake servers and removes the temporary directory.
   */
  async dispose(): Promise<void> {
    await Promise.all(
      this.servers.map((s) =>
        s.stop().catch(() => {
          /* ignore stop errors */
        }),
      ),
    );
    rmSync(this.tempDir, { recursive: true, force: true });
  }
}

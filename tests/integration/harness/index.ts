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
import { Dir } from './dir';
import { FakeSonarQubeServer, FakeSonarQubeServerBuilder } from './fake-sonarqube-server.js';
import { FakeBinariesServer, FakeBinariesServerBuilder } from './fake-binaries-server.js';
import type { CliResult, RunOptions } from './types.js';
import { File } from './file';

export { EnvironmentBuilder } from './environment-builder.js';
export {
  FakeSonarQubeServerBuilder,
  FakeSonarQubeServer,
  ProjectBuilder,
} from './fake-sonarqube-server.js';
export { FakeBinariesServer, FakeBinariesServerBuilder } from './fake-binaries-server.js';
export type { CliResult, RunOptions, RecordedRequest } from './types.js';

export class TestHarness {
  private readonly tempDir: Dir;
  public readonly cwd: Dir;
  public readonly userHome: Dir;
  public readonly cliHome: Dir;
  public readonly stateJsonFile: File;
  public readonly keychainJsonFile: File;
  private readonly servers: FakeSonarQubeServer[] = [];
  private readonly binariesServers: FakeBinariesServer[] = [];
  private _envBuilder?: EnvironmentBuilder;
  private _extraEnv: Record<string, string> = {};

  private constructor(tempDir: string) {
    this.tempDir = new Dir(tempDir);
    this.cwd = this.tempDir.dir('cwd');
    this.userHome = this.tempDir.dir('home');
    this.cliHome = this.userHome.dir('.sonar', 'sonarqube-cli');
    this.stateJsonFile = this.cliHome.file('state.json');
    this.keychainJsonFile = this.tempDir.file('keychain.json');
  }

  static create(): Promise<TestHarness> {
    const tempDir = join(
      tmpdir(),
      `sonar-cli-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
    return Promise.resolve(new TestHarness(tempDir));
  }

  /**
   * Returns the EnvironmentBuilder for this harness (lazily created, shared instance).
   * Configure it before calling run().
   */
  state(): EnvironmentBuilder {
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
   * Creates a new FakeBinariesServerBuilder. Call .start() on the result to get a
   * running server. The server serves the mock sonar-secrets binary for any request
   * and records all requests. It is stopped automatically when dispose() is called.
   */
  newFakeBinariesServer(): FakeBinariesServerBuilder & {
    start: () => Promise<FakeBinariesServer>;
  } {
    const builder = new FakeBinariesServerBuilder();

    const originalStart = builder.start.bind(builder);
    builder.start = async () => {
      const server = await originalStart();
      this.binariesServers.push(server);
      return server;
    };

    return builder;
  }

  /**
   * Runs the CLI binary with the given command string.
   *
   * Before spawning, applies the configured environment (writes state.json + copies binary).
   * Automatically injects SONAR_CLI_DISABLE_KEYCHAIN=true.
   */
  async run(command: string, options?: RunOptions): Promise<CliResult> {
    // Apply environment to tempDir before each run
    if (this._envBuilder) {
      await this._envBuilder.writeTo(this.cliHome.path, this.keychainJsonFile.path);
    }

    // Clean environment — only include the minimum system vars needed to run a binary.
    // This prevents developer-specific env vars (tokens, staging URLs, etc.) from
    // leaking into the CLI process and affecting test behaviour.
    const systemVars: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TERM']) {
      const val = process.env[key];
      if (val !== undefined) systemVars[key] = val;
    }

    const homeEnv: Record<string, string> =
      process.platform === 'win32'
        ? { USERPROFILE: this.userHome.path }
        : { HOME: this.userHome.path };

    const activeBinariesServer = this.binariesServers.at(-1);
    const fakeBinariesEnv: Record<string, string> = activeBinariesServer
      ? { SONAR_CLI_BINARIES_URL: activeBinariesServer.baseUrl() }
      : {};

    const env: Record<string, string> = {
      ...systemVars,
      ...fakeBinariesEnv,
      SONAR_CLI_KEYCHAIN_FILE: this.keychainJsonFile.path,
      CI: 'true',
      ...this._extraEnv,
      ...(options?.extraEnv ?? {}),
      ...homeEnv,
    };

    return runCli(command, env, {
      stdin: options?.stdin,
      timeoutMs: options?.timeoutMs,
      cwd: this.cwd.path,
      browserToken: options?.browserToken,
    });
  }

  /**
   * Stops all fake servers and removes the temporary directory.
   */
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.servers, ...this.binariesServers].map((s) =>
        s.stop().catch(() => {
          /* ignore stop errors */
        }),
      ),
    );
    rmSync(this.tempDir.path, { recursive: true, force: true });
  }
}

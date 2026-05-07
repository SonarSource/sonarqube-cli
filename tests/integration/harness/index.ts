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

// TestHarness — main entry point for integration tests

import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getCliBinaryPath, runCli } from './cli-runner.js';
import { Dir } from './dir';
import { EnvironmentBuilder } from './environment-builder.js';
import { FakeBinariesServer, FakeBinariesServerBuilder } from './fake-binaries-server.js';
import { FakeSonarQubeServer, FakeSonarQubeServerBuilder } from './fake-sonarqube-server.js';
import { File } from './file';
import { buildHomeEnv, IS_WINDOWS } from './platform';
import type { CliResult, RunOptions } from './types.js';

export { EnvironmentBuilder } from './environment-builder.js';
export { FakeBinariesServer, FakeBinariesServerBuilder } from './fake-binaries-server.js';
export {
  FakeSonarQubeServer,
  FakeSonarQubeServerBuilder,
  ProjectBuilder,
} from './fake-sonarqube-server.js';
export { hookScriptName, hookScriptPath, IS_WINDOWS, normalizePath, SCRIPT_EXT } from './platform';
export type { CliResult, RecordedRequest, RunOptions } from './types.js';

export class TestHarness {
  public readonly cwd: Dir;
  public readonly userHome: Dir;
  public readonly cliHome: Dir;
  public readonly stateJsonFile: File;
  public readonly keychainJsonFile: string;
  private readonly tempDir: Dir;
  private readonly servers: FakeSonarQubeServer[] = [];
  private readonly binariesServers: FakeBinariesServer[] = [];
  private _envBuilder?: EnvironmentBuilder;
  private systemEnvVars: Record<string, string> = {};

  private constructor(tempDir: string) {
    this.tempDir = new Dir(tempDir);
    this.cwd = this.tempDir.dir('cwd');
    this.userHome = this.tempDir.dir('home');
    this.cliHome = this.userHome.dir('.sonar', 'sonarqube-cli');
    this.stateJsonFile = this.cliHome.file('state.json');
    this.keychainJsonFile = join(this.cliHome.path, 'keychain.json');
    for (const key of ['PATH', 'PATHEXT', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TERM']) {
      const val = process.env[key];
      if (val !== undefined) this.systemEnvVars[key] = val;
    }
  }

  static create(): Promise<TestHarness> {
    const tempDir = join(tmpdir(), `sonar-cli-harness-${Date.now()}-${crypto.randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    return Promise.resolve(new TestHarness(tempDir));
  }

  /**
   * Returns the EnvironmentBuilder for this harness (lazily created, shared instance).
   * Configure it before calling run().
   */
  state(): EnvironmentBuilder {
    this._envBuilder ??= new EnvironmentBuilder();
    return this._envBuilder;
  }

  /**
   * Convenience: sets up both an active connection and a keychain token in one call.
   * Infers the connection type: 'cloud' when org is provided, 'on-premise' otherwise.
   * Equivalent to harness.state().withAuth(serverUrl, token, org).
   */
  withAuth(serverUrl: string, token: string, org?: string): this {
    this.state().withAuth(serverUrl, token, org);
    return this;
  }

  /**
   * Adds environment variables that will be set for every CLI invocation made
   * through this harness instance. Useful for opting whole test files into
   * test-only behavior (e.g., TTY-guard bypasses) without repeating extraEnv on
   * every `harness.run(...)` call.
   */
  withExtraEnv(env: Record<string, string>): this {
    Object.assign(this.systemEnvVars, env);
    return this;
  }

  withCliInPath(): this {
    const pathBinDir = join(this.userHome.path, '.local', 'bin');
    mkdirSync(pathBinDir, { recursive: true });
    const sonarAlias = join(pathBinDir, IS_WINDOWS ? 'sonar.exe' : 'sonar');
    copyFileSync(getCliBinaryPath(), sonarAlias);
    if (!IS_WINDOWS) {
      chmodSync(sonarAlias, 0o755);
    }
    this.systemEnvVars['PATH'] = this.pathWith([pathBinDir], this.systemEnvVars['PATH']);
    if (IS_WINDOWS) {
      this.systemEnvVars['PATHEXT'] = this.pathWith(['.EXE'], this.systemEnvVars['PATHEXT']);
    }
    return this;
  }

  private pathWith(extraDirs: string[], basePath: string | undefined): string {
    const pathSeparator = IS_WINDOWS ? ';' : ':';
    return [...extraDirs, basePath].filter(Boolean).join(pathSeparator);
  }

  /**
   * Convenience: resets the active connection and any seeded keychain tokens.
   * Equivalent to harness.state().clearAuth().
   */
  clearAuth(): this {
    this.state().clearAuth();
    return this;
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
   * Before spawning, applies the configured environment (writes state.json + seeds tokens).
   * Sets SONARQUBE_CLI_KEYCHAIN_FILE so the CLI uses the file-based keychain backend,
   * avoiding OS credential store access and macOS keychain prompts.
   */
  async run(command: string, options?: RunOptions): Promise<CliResult> {
    return runCli(command, this.env(options), {
      stdin: options?.stdin,
      stdinChunks: options?.stdinChunks,
      timeoutMs: options?.timeoutMs,
      cwd: options?.cwd ?? this.cwd.path,
      browserToken: options?.browserToken,
      browserTokenName: options?.browserTokenName,
    });
  }

  /**
   * Builds the environment used to run the CLI from this harness.
   */
  env(options?: Pick<RunOptions, 'extraEnv'>): Record<string, string> {
    if (this._envBuilder) {
      this._envBuilder.writeTo(this.cliHome.path, this.keychainJsonFile);
    }

    const activeBinariesServer = this.binariesServers.at(-1);
    const fakeBinariesEnv: Record<string, string> = activeBinariesServer
      ? { SONARQUBE_CLI_BINARIES_URL: activeBinariesServer.baseUrl() }
      : {};

    const activeFakeServer = this.servers.at(-1);
    const fakeSonarcloudApiEnv: Record<string, string> = activeFakeServer
      ? { SONARQUBE_CLI_SONARCLOUD_API_URL: activeFakeServer.baseUrl() }
      : {};

    return {
      ...this.systemEnvVars,
      ...fakeBinariesEnv,
      ...fakeSonarcloudApiEnv,
      SONARQUBE_CLI_KEYCHAIN_FILE: this.keychainJsonFile,
      CI: 'true',
      ...options?.extraEnv,
      ...buildHomeEnv(this.userHome.path),
    };
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

    await rm(this.tempDir.path, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 1000,
    }).catch(() => {
      /* best-effort: temp dirs are cleaned up by the OS */
    });
  }
}

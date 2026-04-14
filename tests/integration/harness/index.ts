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

import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli } from './cli-runner.js';
import { EnvironmentBuilder } from './environment-builder.js';
import { Dir } from './dir';
import { buildHomeEnv } from './platform';
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
export { IS_WINDOWS, SCRIPT_EXT, hookScriptName, hookScriptPath, normalizePath } from './platform';

export class TestHarness {
  public readonly cwd: Dir;
  public readonly userHome: Dir;
  public readonly cliHome: Dir;
  public readonly stateJsonFile: File;
  public readonly keychainServiceName: string;
  private readonly tempDir: Dir;
  private readonly servers: FakeSonarQubeServer[] = [];
  private readonly binariesServers: FakeBinariesServer[] = [];
  private readonly seededAccounts: string[] = [];
  private readonly _extraEnv: Record<string, string> = {};
  private _envBuilder?: EnvironmentBuilder;

  private constructor(tempDir: string) {
    this.tempDir = new Dir(tempDir);
    this.cwd = this.tempDir.dir('cwd');
    this.userHome = this.tempDir.dir('home');
    this.cliHome = this.userHome.dir('.sonar', 'sonarqube-cli');
    this.stateJsonFile = this.cliHome.file('state.json');
    this.keychainServiceName = `sonar-cli-integ-${crypto.randomUUID()}`;
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
    if (!this._envBuilder) {
      this._envBuilder = new EnvironmentBuilder();
    }
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
   * Sets SONARQUBE_CLI_KEYCHAIN_SERVICE so the CLI reads tokens from the same isolated
   * OS credential store namespace that the harness seeded via Bun.secrets.
   */
  async run(command: string, options?: RunOptions): Promise<CliResult> {
    if (this._envBuilder) {
      const accounts = await this._envBuilder.writeTo(this.cliHome.path, this.keychainServiceName);
      this.seededAccounts.push(...accounts);
    }

    // Clean environment — only include the minimum system vars needed to run a binary.
    // This prevents developer-specific env vars (tokens, staging URLs, etc.) from
    // leaking into the CLI process and affecting test behaviour.
    const systemVars: Record<string, string> = {};
    for (const key of [
      'PATH',
      'HOME',
      'TMPDIR',
      'USER',
      'LOGNAME',
      'SHELL',
      'TERM',
      'DBUS_SESSION_BUS_ADDRESS',
      'GNOME_KEYRING_CONTROL',
    ]) {
      const val = process.env[key];
      if (val !== undefined) systemVars[key] = val;
    }

    const activeBinariesServer = this.binariesServers.at(-1);
    const fakeBinariesEnv: Record<string, string> = activeBinariesServer
      ? { SONARQUBE_CLI_BINARIES_URL: activeBinariesServer.baseUrl() }
      : {};

    // Redirect SonarCloud API calls to the active fake server so that
    // integration tests don't hit api.sonarcloud.io (e.g. for SQAA analysis)
    const activeFakeServer = this.servers.at(-1);
    const fakeSonarcloudApiEnv: Record<string, string> = activeFakeServer
      ? { SONARQUBE_CLI_SONARCLOUD_API_URL: activeFakeServer.baseUrl() }
      : {};

    const env: Record<string, string> = {
      ...systemVars,
      ...fakeBinariesEnv,
      ...fakeSonarcloudApiEnv,
      SONARQUBE_CLI_KEYCHAIN_SERVICE: this.keychainServiceName,
      CI: 'true',
      ...this._extraEnv,
      ...options?.extraEnv,
      ...buildHomeEnv(this.userHome.path),
    };

    return runCli(command, env, {
      stdin: options?.stdin,
      stdinChunks: options?.stdinChunks,
      timeoutMs: options?.timeoutMs,
      cwd: this.cwd.path,
      browserToken: options?.browserToken,
    });
  }

  /**
   * Stops all fake servers, cleans up seeded keychain tokens, and removes the temporary directory.
   */
  async dispose(): Promise<void> {
    await Promise.all(
      [...this.servers, ...this.binariesServers].map((s) =>
        s.stop().catch(() => {
          /* ignore stop errors */
        }),
      ),
    );

    for (const account of this.seededAccounts) {
      await Bun.secrets
        .delete({ service: this.keychainServiceName, name: account })
        .catch(() => {});
    }
    this.seededAccounts.length = 0;

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

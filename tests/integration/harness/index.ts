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

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ENV_DO_NOT_TRACK, ENV_SQAA_RETRY_BASE_DELAY_MS } from '@/core/config-constants.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';

import { applyIsolatedSpawnEnv } from '../../_common/isolated-cli-env.js';
import { getCliBinaryPath, runCli } from './cli-runner.js';
import { Dir } from './dir';
import { EnvironmentBuilder } from './environment-builder.js';
import { FakeBinariesServer, FakeBinariesServerBuilder } from './fake-binaries-server.js';
import { FakeGitLabServer, FakeGitLabServerBuilder } from './fake-gitlab-server.js';
import { FakeSonarQubeServer, FakeSonarQubeServerBuilder } from './fake-sonarqube-server.js';
import { FakeUpdateScriptServer } from './fake-update-script-server.js';
import { File } from './file';
import { type InteractiveSession, startInteractiveSession } from './interactive-session.js';
import { buildHomeEnv, IS_WINDOWS } from './platform';
import type { CliResult, RunInteractiveOptions, RunOptions } from './types.js';

export { FakeGitLabServer, FakeGitLabServerBuilder } from './fake-gitlab-server.js';
export { FakeSonarQubeServer, FakeSonarQubeServerBuilder } from './fake-sonarqube-server.js';
export { InteractiveSession } from './interactive-session.js';
export { hookScriptName, hookScriptPath, IS_WINDOWS, normalizePath } from './platform';
export type { CliResult, RecordedRequest, RunInteractiveOptions } from './types.js';

export class TestHarness {
  public readonly cwd: Dir;
  public readonly userHome: Dir;
  public readonly sonarUserHome: Dir;
  public readonly cliHome: Dir;
  public readonly stateJsonFile: File;
  public readonly keychainJsonFile: string;
  private readonly tempDir: Dir;
  private readonly servers: FakeSonarQubeServer[] = [];
  private readonly binariesServers: FakeBinariesServer[] = [];
  private readonly gitlabServers: FakeGitLabServer[] = [];
  private readonly updateScriptServers: FakeUpdateScriptServer[] = [];
  private _envBuilder?: EnvironmentBuilder;
  private systemEnvVars: Record<string, string> = {};
  private readonly sessions: InteractiveSession[] = [];

  private constructor(tempDir: string) {
    this.tempDir = new Dir(tempDir);
    this.cwd = this.tempDir.dir('cwd');
    this.userHome = this.tempDir.dir('home');
    this.sonarUserHome = this.userHome.dir('.sonar');
    this.cliHome = this.sonarUserHome.dir('sonarqube-cli');
    this.stateJsonFile = this.cliHome.file('state.json');
    this.keychainJsonFile = join(this.cliHome.path, 'keychain.json');
    for (const key of ['PATH', 'PATHEXT', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TERM']) {
      const val = process.env[key];
      if (val !== undefined) this.systemEnvVars[key] = val;
    }
  }

  static create(): Promise<TestHarness> {
    const rawDir = join(tmpdir(), `sonar-cli-harness-${Date.now()}-${crypto.randomUUID()}`);
    mkdirSync(rawDir, { recursive: true });
    // Canonicalize with the same helper the CLI uses (canonicalizePath →
    // realpathSync.native), so the harness's paths match what production records
    // and resolves. This matters on two fronts:
    //   - macOS exposes $TMPDIR as `/var/folders/...`, a symlink to
    //     `/private/var/folders/...`, which realpath resolves.
    //   - Windows CI temp dirs contain an 8.3 short component (e.g. `RUNNER~1`);
    //     `.native` expands it to the long form (`runneradmin`) that `git` and
    //     `process.cwd()` report, so seeded/expected paths match the CLI's.
    const tempDir = canonicalizePath(rawDir);
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

  /** Creates a fake GitLab server. Call .start() on the result; stopped automatically on dispose(). */
  newFakeGitLabServer(): FakeGitLabServerBuilder & {
    start: () => Promise<FakeGitLabServer>;
  } {
    const builder = new FakeGitLabServerBuilder();
    const originalStart = builder.start.bind(builder);
    builder.start = async () => {
      const server = await originalStart();
      this.gitlabServers.push(server);
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
   * Creates a fake update script server that returns an install script payload.
   * Use this to exercise installer-script downloads without hitting GitHub.
   * The server is stopped automatically when dispose() is called.
   */
  newFakeUpdateScriptServer(version: string): FakeUpdateScriptServer {
    const server = new FakeUpdateScriptServer(version).start();
    this.updateScriptServers.push(server);
    return server;
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
      stdinChunkDelayMs: options?.stdinChunkDelayMs,
      timeoutMs: options?.timeoutMs,
      cwd: options?.cwd ?? this.cwd.path,
      browserToken: options?.browserToken,
      browserTokenName: options?.browserTokenName,
      binaryPath: options?.binaryPath,
    });
  }

  /**
   * Spawns the CLI and returns a session the test drives prompt-by-prompt.
   * Use `run()` when the command is non-interactive or only needs dump-all stdin.
   */
  runInteractive(command: string, options?: RunInteractiveOptions): InteractiveSession {
    const session = startInteractiveSession(command, this.env(options), {
      cwd: options?.cwd ?? this.cwd.path,
      timeoutMs: options?.timeoutMs,
      waitTimeoutMs: options?.waitTimeoutMs,
      binaryPath: options?.binaryPath,
      browserToken: options?.browserToken,
      browserTokenName: options?.browserTokenName,
    });
    this.sessions.push(session);
    return session;
  }

  /**
   * Builds the environment used to run the CLI from this harness.
   */
  env(options?: Pick<RunOptions, 'extraEnv'>): Record<string, string> {
    if (this._envBuilder) {
      this._envBuilder.writeTo(this.cliHome.path, this.keychainJsonFile);
    } else if (!existsSync(this.stateJsonFile.path)) {
      new EnvironmentBuilder().writeTo(this.cliHome.path, this.keychainJsonFile);
    }
    const builderExtraEnv = this._envBuilder?.getExtraEnv() ?? {};

    const activeBinariesServer = this.binariesServers.at(-1);
    const fakeBinariesEnv: Record<string, string> = activeBinariesServer
      ? { SONARQUBE_CLI_BINARIES_URL: activeBinariesServer.baseUrl() }
      : {};

    const activeFakeServer = this.servers.at(-1);
    const fakeSonarcloudEnv: Record<string, string> = {};
    if (activeFakeServer) {
      fakeSonarcloudEnv.SONARQUBE_CLI_SONARCLOUD_API_URL = activeFakeServer.baseUrl();
      if (activeFakeServer.impersonatesSonarCloud()) {
        fakeSonarcloudEnv.SONARQUBE_CLI_SONARCLOUD_URL = activeFakeServer.baseUrl();
      }
    }

    const activeUpdateServer = this.updateScriptServers.at(-1);
    const fakeUpdateScriptEnv: Record<string, string> = activeUpdateServer
      ? { SONARQUBE_CLI_UPDATE_SCRIPT_BASE_URL: activeUpdateServer.baseUrl() }
      : {};

    const composed: Record<string, string> = {
      ...this.systemEnvVars,
      ...builderExtraEnv,
      ...fakeBinariesEnv,
      ...fakeSonarcloudEnv,
      ...fakeUpdateScriptEnv,
      SONARQUBE_CLI_KEYCHAIN_FILE: this.keychainJsonFile,
      CI: 'true',
      [ENV_SQAA_RETRY_BASE_DELAY_MS]: '0',
      ...options?.extraEnv,
      ...buildHomeEnv(this.userHome.path),
    };

    // Prepend docker mock bin dir to the fully-composed PATH so it doesn't
    // clobber any PATH already set by withCliInPath().
    const dockerBin = this._envBuilder?.dockerMockBinDir;
    if (dockerBin) {
      composed.PATH = `${dockerBin}:${composed.PATH ?? process.env.PATH ?? ''}`;
    }

    // withTelemetryEnabled() re-enables consent so the events sink is written. Egress stays
    // severed either way: applyIsolatedSpawnEnv pins the egress mode to off for every spawn.
    if (this._envBuilder?.telemetryEnabled) {
      composed[ENV_DO_NOT_TRACK] = '0';
    }
    return applyIsolatedSpawnEnv(composed);
  }

  /**
   * Stops all fake servers and removes the temporary directory.
   */
  async dispose(): Promise<void> {
    for (const session of this.sessions) {
      session.kill();
    }
    await Promise.all(this.sessions.map((session) => session.waitFinish().catch(() => undefined)));

    await Promise.all(
      [...this.servers, ...this.binariesServers, ...this.gitlabServers].map((s) =>
        s.stop().catch(() => {
          /* ignore stop errors */
        }),
      ),
    );
    await Promise.all(this.updateScriptServers.map((s) => s.stop().catch(() => {})));

    await rm(this.tempDir.path, {
      recursive: true,
      force: true,
      maxRetries: IS_WINDOWS ? 15 : 5,
      retryDelay: IS_WINDOWS ? 200 : 100,
    }).catch(() => {
      /* best-effort: temp dirs are cleaned up by the OS */
    });
  }
}

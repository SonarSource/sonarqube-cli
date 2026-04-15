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

/**
 * E2e tests that exercise the real Bun.secrets OS credential store via the CLI binary.
 *
 * Each test starts a FakeSonarQubeServer, runs actual CLI commands (auth login,
 * logout, purge), and verifies tokens are stored/removed from the real OS keychain.
 * SONARQUBE_CLI_KEYCHAIN_SERVICE isolates tokens per test run.
 */

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCli, getCliBinaryPath } from '../integration/harness/cli-runner';
import { FakeSonarQubeServer, FakeSonarQubeServerBuilder } from '../integration/harness';
import { buildHomeEnv } from '../integration/harness/platform';
import { generateKeychainAccount } from '../../src/lib/keychain';
import { getDefaultState } from '../../src/lib/state';

setDefaultTimeout(30_000);

// Verify the binary exists before running any tests
getCliBinaryPath();

interface E2eContext {
  serviceName: string;
  tempDir: string;
  userHome: string;
  cliHome: string;
  cwd: string;
  server: FakeSonarQubeServer;
  trackedAccounts: Set<string>;
}

function buildEnv(ctx: E2eContext): Record<string, string> {
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

  return {
    ...systemVars,
    ...buildHomeEnv(ctx.userHome),
    SONARQUBE_CLI_KEYCHAIN_SERVICE: ctx.serviceName,
    CI: 'true',
  };
}

function writeState(cliHome: string): void {
  mkdirSync(cliHome, { recursive: true });
  const state = getDefaultState('e2e-test');
  state.telemetry.enabled = false;
  writeFileSync(join(cliHome, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
}

describe('Bun.secrets keychain via CLI', () => {
  let ctx: E2eContext;

  beforeEach(async () => {
    const tempDir = join(tmpdir(), `sonar-e2e-keychain-${crypto.randomUUID()}`);
    const userHome = join(tempDir, 'home');
    const cliHome = join(userHome, '.sonar', 'sonarqube-cli');
    const cwd = join(tempDir, 'cwd');
    mkdirSync(cwd, { recursive: true });

    writeState(cliHome);

    const server = await new FakeSonarQubeServerBuilder().withAuthToken('e2e-token').start();

    ctx = {
      serviceName: `sonar-e2e-${crypto.randomUUID()}`,
      tempDir,
      userHome,
      cliHome,
      cwd,
      server,
      trackedAccounts: new Set(),
    };
  });

  afterEach(async () => {
    await ctx.server.stop().catch(() => {});

    for (const account of ctx.trackedAccounts) {
      await Bun.secrets.delete({ service: ctx.serviceName, name: account }).catch(() => {});
    }

    rmSync(ctx.tempDir, { recursive: true, force: true });
  });

  it('auth login --with-token stores a token in the OS keychain', async () => {
    const env = buildEnv(ctx);
    const result = await runCli(
      `auth login --with-token e2e-token --server ${ctx.server.baseUrl()}`,
      env,
      { cwd: ctx.cwd },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Authentication successful');

    const account = generateKeychainAccount(ctx.server.baseUrl());
    ctx.trackedAccounts.add(account);

    const stored = await Bun.secrets.get({ service: ctx.serviceName, name: account });
    expect(stored).toBe('e2e-token');
  });

  it('auth logout removes the token from the OS keychain', async () => {
    const env = buildEnv(ctx);

    // Login first
    const loginResult = await runCli(
      `auth login --with-token e2e-token --server ${ctx.server.baseUrl()}`,
      env,
      { cwd: ctx.cwd },
    );
    expect(loginResult.exitCode).toBe(0);

    const account = generateKeychainAccount(ctx.server.baseUrl());
    ctx.trackedAccounts.add(account);

    // Verify the token was stored
    const stored = await Bun.secrets.get({ service: ctx.serviceName, name: account });
    expect(stored).toBe('e2e-token');

    // Logout
    const logoutResult = await runCli('auth logout', env, { cwd: ctx.cwd });
    expect(logoutResult.exitCode).toBe(0);
    expect(logoutResult.stdout).toContain('Logged out');

    const afterLogout = await Bun.secrets.get({ service: ctx.serviceName, name: account });
    expect(afterLogout).toBeNull();
  });

  it('auth purge removes all tokens from the OS keychain', async () => {
    const env = buildEnv(ctx);

    // Login to a server
    const loginResult = await runCli(
      `auth login --with-token e2e-token --server ${ctx.server.baseUrl()}`,
      env,
      { cwd: ctx.cwd },
    );
    expect(loginResult.exitCode).toBe(0);

    const account = generateKeychainAccount(ctx.server.baseUrl());
    ctx.trackedAccounts.add(account);

    // Purge with confirmation
    const purgeResult = await runCli('auth purge', env, { cwd: ctx.cwd, stdin: 'y\n' });
    expect(purgeResult.exitCode).toBe(0);

    const afterPurge = await Bun.secrets.get({ service: ctx.serviceName, name: account });
    expect(afterPurge).toBeNull();
  });

  it('auth status reports connected when token exists in OS keychain', async () => {
    const env = buildEnv(ctx);

    // Login first
    const loginResult = await runCli(
      `auth login --with-token e2e-token --server ${ctx.server.baseUrl()}`,
      env,
      { cwd: ctx.cwd },
    );
    expect(loginResult.exitCode).toBe(0);

    const account = generateKeychainAccount(ctx.server.baseUrl());
    ctx.trackedAccounts.add(account);

    // Check status
    const statusResult = await runCli('auth status', env, { cwd: ctx.cwd });
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toContain('Connected');
  });
});

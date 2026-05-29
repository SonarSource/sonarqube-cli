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
 * logout, status), and verifies tokens are stored/removed from the real OS keychain.
 * SONARQUBE_CLI_KEYCHAIN_SERVICE isolates tokens per test run.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { generateKeychainAccount } from '../../src/lib/keychain';
import { getDefaultState } from '../../src/lib/state';
import { addOrUpdateConnection } from '../../src/lib/state-manager';
import { FakeSonarQubeServer, FakeSonarQubeServerBuilder } from '../integration/harness';
import { getCliBinaryPath, runCli } from '../integration/harness/cli-runner';
import { buildHomeEnv } from '../integration/harness/platform';

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

async function setupAuth(ctx: E2eContext): Promise<string> {
  const token = 'e2e-token';
  const serverUrl = ctx.server.baseUrl();
  const account = generateKeychainAccount(serverUrl);
  ctx.trackedAccounts.add(account);

  await Bun.secrets.set({ service: ctx.serviceName, name: account, value: token });

  const state = getDefaultState('e2e-test');
  state.telemetry.enabled = false;
  addOrUpdateConnection(state, serverUrl, 'on-premise');
  writeFileSync(join(ctx.cliHome, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');

  return account;
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

  it('auth logout removes the token from the OS keychain', async () => {
    const env = buildEnv(ctx);
    const account = await setupAuth(ctx);

    const stored = await Bun.secrets.get({ service: ctx.serviceName, name: account });
    expect(stored).toBe('e2e-token');

    const logoutResult = await runCli('auth logout', env, { cwd: ctx.cwd });
    expect(logoutResult.exitCode).toBe(0);
    expect(logoutResult.stdout).toContain('Logged out');

    const afterLogout = await Bun.secrets.get({ service: ctx.serviceName, name: account });
    expect(afterLogout).toBeNull();
  });

  it('auth status reports connected when token exists in OS keychain', async () => {
    const env = buildEnv(ctx);
    const account = await setupAuth(ctx);

    expect(await Bun.secrets.get({ service: ctx.serviceName, name: account })).toBe('e2e-token');

    const statusResult = await runCli('auth status', env, { cwd: ctx.cwd });
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toContain('Connected');
  });
});

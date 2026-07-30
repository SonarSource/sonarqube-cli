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

// Integration tests for env-var auth's state.auth.connections sync (see auth-connection-recorder.ts).

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ENV_ORG, ENV_SERVER, ENV_TOKEN } from '@/core/host/auth-resolver.ts';
import { generateKeychainAccount } from '@/core/host/keychain.ts';

import { TestHarness } from '../../harness';

interface StoredAuthConnection {
  serverUrl: string;
  orgKey?: string;
  type: string;
  authenticatedAt: string;
  envOnly?: boolean;
}

interface StoredState {
  auth: {
    isAuthenticated: boolean;
    connections: StoredAuthConnection[];
  };
}

function readKeychainTokens(keychainFile: string): Record<string, string> {
  try {
    const store = JSON.parse(readFileSync(keychainFile, 'utf-8')) as {
      tokens: Record<string, string>;
    };
    return store.tokens;
  } catch {
    return {};
  }
}

describe('env-var auth — state sync', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'records a connection in state.auth.connections without ever writing to the keychain',
    async () => {
      const server = await harness.newFakeServer().start();

      const result = await harness.run('system status', {
        extraEnv: { [ENV_TOKEN]: 'env-auth-token', [ENV_SERVER]: server.baseUrl() },
      });

      expect(result.exitCode).toBe(0);

      const state = harness.stateJsonFile.asJson() as StoredState;
      expect(state.auth.isAuthenticated).toBe(true);
      expect(state.auth.connections).toHaveLength(1);
      expect(state.auth.connections[0]).toMatchObject({
        serverUrl: server.baseUrl(),
        type: 'on-premise',
        envOnly: true,
      });

      expect(readKeychainTokens(harness.keychainJsonFile)).toEqual({});
    },
    { timeout: 20000 },
  );

  it(
    'auth logout reports already logged out after the env vars are unset',
    async () => {
      const server = await harness.newFakeServer().start();

      const envResult = await harness.run('system status', {
        extraEnv: { [ENV_TOKEN]: 'env-auth-token', [ENV_SERVER]: server.baseUrl() },
      });
      expect(envResult.exitCode).toBe(0);
      expect(harness.stateJsonFile.asJson().auth.isAuthenticated).toBe(true);

      const logoutResult = await harness.run('auth logout');

      expect(logoutResult.exitCode).toBe(0);
      expect(logoutResult.stdout).toContain('You are already logged out.');

      const revokeRequest = server
        .getRecordedRequests()
        .find((request) => request.path === '/api/user_tokens/revoke');
      expect(revokeRequest).toBeUndefined();

      const state = harness.stateJsonFile.asJson() as StoredState;
      expect(state.auth.connections).toHaveLength(1);
    },
    { timeout: 20000 },
  );

  it(
    'does not touch the keychain when env vars override an existing keychain-based connection',
    async () => {
      const loginServer = await harness.newFakeServer().withAuthToken('login-token').start();
      harness
        .state()
        .withActiveConnection(loginServer.baseUrl())
        .withKeychainToken(loginServer.baseUrl(), 'login-token');
      const loginAccount = generateKeychainAccount(loginServer.baseUrl());

      const envServer = await harness.newFakeServer().start();

      const result = await harness.run('system status', {
        extraEnv: {
          [ENV_TOKEN]: 'env-auth-token',
          [ENV_SERVER]: envServer.baseUrl(),
          [ENV_ORG]: 'other-org',
        },
      });

      expect(result.exitCode).toBe(0);

      const state = harness.stateJsonFile.asJson() as StoredState;
      expect(state.auth.connections).toHaveLength(1);
      expect(state.auth.connections[0]).toMatchObject({
        serverUrl: envServer.baseUrl(),
        orgKey: 'other-org',
      });

      const tokensAfter = readKeychainTokens(harness.keychainJsonFile);
      expect(tokensAfter).toEqual({ [loginAccount]: 'login-token' });
    },
    { timeout: 20000 },
  );
});

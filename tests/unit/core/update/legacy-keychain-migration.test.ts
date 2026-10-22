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

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';

import * as keychain from '@/core/host/keychain.ts';
import type { AuthConnection, CliState } from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import { migrateLegacyKeychainTokens } from '@/core/update/legacy-keychain-migration.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';
import { createKeychainTestHandle } from '../host/keychain-test-handle.ts';

const CLOUD_URL = 'https://sonarcloud.io';

function connection(overrides: Partial<AuthConnection> = {}): AuthConnection {
  return {
    id: 'connection-1',
    type: 'cloud',
    serverUrl: CLOUD_URL,
    orgKey: 'org1',
    authenticatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function stateWith(connections: AuthConnection[]): CliState {
  const state = getDefaultState('1.0.0');
  state.auth.connections = connections;
  return state;
}

function readStoredTokens(): Record<string, string> {
  const file = process.env.SONARQUBE_CLI_KEYCHAIN_FILE as string;
  return (JSON.parse(readFileSync(file, 'utf-8')) as { tokens: Record<string, string> }).tokens;
}

describe('migrateLegacyKeychainTokens', () => {
  const keychainHandle = createKeychainTestHandle();
  let loadStateSpy: Mock<typeof stateRepository.loadState>;

  function useConnections(connections: AuthConnection[]): void {
    loadStateSpy.mockReturnValue(stateWith(connections));
  }

  beforeEach(() => {
    keychainHandle.setup();
    loadStateSpy = spyOn(stateRepository, 'loadState');
  });

  afterEach(() => {
    keychainHandle.teardown();
    loadStateSpy.mockRestore();
  });

  it('moves the token stored under hostname:org to the server-only account', async () => {
    keychainHandle.seedLegacyToken(CLOUD_URL, 'legacy-token', 'org1');
    useConnections([connection()]);

    await migrateLegacyKeychainTokens(new FakeConsole());

    expect(readStoredTokens()).toEqual({ 'sonarcloud.io': 'legacy-token' });
  });

  it('leaves a connection without an organization alone', async () => {
    keychainHandle.seedLegacyToken(CLOUD_URL, 'legacy-token', 'org1');
    useConnections([connection({ type: 'on-premise', orgKey: undefined })]);

    await migrateLegacyKeychainTokens(new FakeConsole());

    expect(readStoredTokens()).toEqual({ 'sonarcloud.io:org1': 'legacy-token' });
  });

  it('stores nothing when the legacy account has no token', async () => {
    await keychainHandle.seedToken('https://other.example.com', 'other-token');
    useConnections([connection()]);

    await migrateLegacyKeychainTokens(new FakeConsole());

    expect(readStoredTokens()).toEqual({ 'other.example.com': 'other-token' });
  });

  it('warns once and gives up when the keychain fails', async () => {
    const moveSpy = spyOn(keychain, 'moveToken').mockRejectedValue(new Error('locked'));
    useConnections([connection()]);
    const console = new FakeConsole();

    await migrateLegacyKeychainTokens(console);

    expect(console.findCall('warn', "Run 'sonar auth login'")).toBeDefined();
    moveSpy.mockRestore();
  });

  it('stays silent when there is no usable keychain', async () => {
    const moveSpy = spyOn(keychain, 'moveToken').mockRejectedValue(
      new keychain.MissingKeychainError('libsecret not available'),
    );
    useConnections([connection()]);
    const console = new FakeConsole();

    await migrateLegacyKeychainTokens(console);

    expect(console.calls).toEqual([]);
    moveSpy.mockRestore();
  });
});

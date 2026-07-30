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
 * Unit tests for recordConnectionFromAuth — the shared step that makes env-var
 * auth leave the same state.auth.connections trace `sonar auth login` does
 * (minus the keychain write, which this module never performs at all).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import { recordConnectionFromAuth } from '@/core/host/auth-connection-recorder.ts';
import type { ResolvedAuth } from '@/core/host/auth-resolver.ts';
import { addOrUpdateConnection, getActiveConnection } from '@/core/state/state-manager.ts';
import { loadState, saveState } from '@/core/state/state-repository.ts';

import { mockIdentityGetSafe } from '../telemetry/identity-api-mock.ts';

function serverAuth(token: string, serverUrl = 'https://sq.example.com'): ResolvedAuth {
  return { token, serverUrl, connectionType: 'on-premise' };
}

function cloudAuth(token: string, orgKey = 'my-org'): ResolvedAuth {
  return { token, serverUrl: 'https://sonarcloud.io', orgKey, connectionType: 'cloud' };
}

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'auth-connection-recorder-test-'));
  process.env[ENV_SONAR_USER_HOME] = testDir;
});

afterEach(() => {
  delete process.env[ENV_SONAR_USER_HOME];
  rmSync(testDir, { recursive: true, force: true });
});

describe('recordConnectionFromAuth', () => {
  it('records a new connection and fetches identity when none exists', async () => {
    const getSafeSpy = mockIdentityGetSafe({ status: [{ ok: true, id: 'sqs-new' }] });

    const connection = await recordConnectionFromAuth(serverAuth('t1'));

    expect(connection.serverUrl).toBe('https://sq.example.com');
    expect(connection.type).toBe('on-premise');
    expect(connection.sqsInstallationId).toBe('sqs-new');

    const state = loadState();
    expect(getActiveConnection(state)?.serverUrl).toBe('https://sq.example.com');
    getSafeSpy.mockRestore();
  });

  it('no-ops (no network call) when the active connection already matches and is complete', async () => {
    const state = loadState();
    const existing = addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
      orgKey: 'my-org',
    });
    existing.userUuid = 'u';
    existing.organizationUuidV4 = 'o';
    saveState(state);

    const getSafeSpy = mockIdentityGetSafe();

    const connection = await recordConnectionFromAuth(cloudAuth('t2'));

    expect(connection.userUuid).toBe('u');
    expect(connection.organizationUuidV4).toBe('o');
    expect(getSafeSpy).not.toHaveBeenCalled();
    getSafeSpy.mockRestore();
  });

  it('replaces a mismatched active connection and fetches fresh identity', async () => {
    const state = loadState();
    addOrUpdateConnection(state, 'https://old.example.com', 'on-premise');
    saveState(state);

    const getSafeSpy = mockIdentityGetSafe({
      user: [{ ok: true, id: 'fresh-user' }],
      org: [{ ok: true, uuidV4: 'fresh-org' }],
    });

    const connection = await recordConnectionFromAuth(cloudAuth('t3'));

    expect(connection.serverUrl).toBe('https://sonarcloud.io');
    expect(connection.userUuid).toBe('fresh-user');
    expect(connection.organizationUuidV4).toBe('fresh-org');

    const reloaded = loadState();
    expect(reloaded.auth.connections).toHaveLength(1);
    expect(getActiveConnection(reloaded)?.serverUrl).toBe('https://sonarcloud.io');
    getSafeSpy.mockRestore();
  });

  it('without force, a matching complete connection wins over a new tokenName', async () => {
    const state = loadState();
    const existing = addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
      orgKey: 'my-org',
      tokenName: 'original-token-name',
    });
    existing.userUuid = 'u';
    existing.organizationUuidV4 = 'o';
    saveState(state);

    const connection = await recordConnectionFromAuth(cloudAuth('t4'), {
      tokenName: 'ignored-token-name',
    });

    expect(connection.tokenName).toBe('original-token-name');
  });

  it('force: true rewrites the connection (e.g. tokenName) even when already complete', async () => {
    const state = loadState();
    const existing = addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
      orgKey: 'my-org',
      tokenName: 'original-token-name',
    });
    existing.userUuid = 'u';
    existing.organizationUuidV4 = 'o';
    saveState(state);

    const connection = await recordConnectionFromAuth(cloudAuth('t4'), {
      tokenName: 'new-token-name',
      force: true,
    });

    expect(connection.tokenName).toBe('new-token-name');
  });

  it('sets organizationUuidV4 only for cloud auth with an org key, and sqsInstallationId only for on-premise', async () => {
    const getSafeSpy = mockIdentityGetSafe({
      user: [{ ok: true, id: 'user-a' }],
      status: [{ ok: true, id: 'sqs-a' }],
    });

    const onPremConnection = await recordConnectionFromAuth(serverAuth('t5'));
    expect(onPremConnection.sqsInstallationId).toBe('sqs-a');
    expect(onPremConnection.organizationUuidV4).toBeUndefined();

    getSafeSpy.mockRestore();
  });

  it('marks the connection envOnly when recorded via the env-var path', async () => {
    const getSafeSpy = mockIdentityGetSafe({ status: [{ ok: true, id: 'sqs-env' }] });

    const connection = await recordConnectionFromAuth(serverAuth('t6'), { envOnly: true });

    expect(connection.envOnly).toBe(true);
    getSafeSpy.mockRestore();
  });

  it('leaves envOnly unset for a login-style call (no envOnly option)', async () => {
    const getSafeSpy = mockIdentityGetSafe({ status: [{ ok: true, id: 'sqs-login' }] });

    const connection = await recordConnectionFromAuth(serverAuth('t7'), {
      tokenName: 'cli-token',
      force: true,
    });

    expect(connection.envOnly).toBeUndefined();
    getSafeSpy.mockRestore();
  });
});

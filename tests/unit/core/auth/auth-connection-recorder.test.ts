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

/** Unit tests for recordConnectionFromAuth — the state write step `sonar auth login` uses. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { recordConnectionFromAuth } from '@/core/auth/auth-connection-recorder.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import type { CliState } from '@/core/state/state.ts';
import { addOrUpdateConnection, getActiveConnection } from '@/core/state/state-manager.ts';
import { loadState, updateState } from '@/core/state/state-repository.ts';
import * as identityFetchModule from '@/core/telemetry/identity-fetch.ts';

import { createKeychainTestHandle } from '../host/keychain-test-handle.ts';
import { mockIdentityGetSafe } from '../telemetry/identity-api-mock.ts';

function serverAuth(token: string, serverUrl = 'https://sq.example.com'): ResolvedAuth {
  return new ResolvedAuth({ token, serverUrl, connectionType: 'on-premise', source: 'state' });
}

function cloudAuth(token: string, orgKey = 'my-org'): ResolvedAuth {
  return new ResolvedAuth({
    token,
    serverUrl: 'https://sonarcloud.io',
    orgKey,
    connectionType: 'cloud',
    source: 'state',
  });
}

function writeStateFixture(state: CliState): void {
  updateState((latest) => {
    Object.assign(latest, state);
  });
}

let testDir: string;
const keychain = createKeychainTestHandle();

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'auth-connection-recorder-test-'));
  process.env[ENV_SONAR_USER_HOME] = testDir;
  keychain.setup();
});

afterEach(() => {
  keychain.teardown();
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
    existing.enterpriseUuid = null;
    writeStateFixture(state);

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
    writeStateFixture(state);

    const getSafeSpy = mockIdentityGetSafe({
      user: [{ ok: true, id: 'fresh-user' }],
      org: [{ ok: true, uuidV4: 'fresh-org' }],
    });

    const connection = await recordConnectionFromAuth(cloudAuth('t3'));

    expect(connection.serverUrl).toBe('https://sonarcloud.io');
    expect(connection.userUuid).toBe('fresh-user');
    expect(connection.organizationUuidV4).toBe('fresh-org');
    expect(connection.enterpriseUuid).toBeNull();

    const reloaded = loadState();
    expect(reloaded.auth.connections).toHaveLength(1);
    expect(getActiveConnection(reloaded)?.serverUrl).toBe('https://sonarcloud.io');
    getSafeSpy.mockRestore();
  });

  it('records login after another process changes the prior connection during identity lookup', async () => {
    const initial = loadState();
    addOrUpdateConnection(initial, 'https://old.example.com', 'on-premise');
    writeStateFixture(initial);
    const identitySpy = spyOn(identityFetchModule, 'resolveTelemetryIdentity').mockImplementation(
      () => {
        const concurrent = loadState();
        addOrUpdateConnection(concurrent, 'https://old.example.com', 'on-premise');
        concurrent.config.cliVersion = '2.0.0';
        writeStateFixture(concurrent);
        return Promise.resolve({
          user_uuid: 'new-user',
          organization_uuid_v4: null,
          sqs_installation_id: 'new-server',
        });
      },
    );

    try {
      const connection = await recordConnectionFromAuth(
        serverAuth('new-token', 'https://new.example.com'),
        {
          force: true,
          tokenName: 'new-token',
        },
      );
      const saved = loadState();
      expect(connection.serverUrl).toBe('https://new.example.com');
      expect(getActiveConnection(saved)?.serverUrl).toBe('https://new.example.com');
      expect(getActiveConnection(saved)?.tokenName).toBe('new-token');
      expect(saved.config.cliVersion).toBe('2.0.0');
    } finally {
      identitySpy.mockRestore();
    }
  });

  it('without force, a matching complete connection wins over a new tokenName', async () => {
    const state = loadState();
    const existing = addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
      orgKey: 'my-org',
      tokenName: 'original-token-name',
    });
    existing.userUuid = 'u';
    existing.organizationUuidV4 = 'o';
    existing.enterpriseUuid = null;
    writeStateFixture(state);

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
    existing.enterpriseUuid = null;
    writeStateFixture(state);

    const getSafeSpy = mockIdentityGetSafe();
    const connection = await recordConnectionFromAuth(cloudAuth('t4'), {
      tokenName: 'new-token-name',
      force: true,
    });

    expect(connection.tokenName).toBe('new-token-name');
    getSafeSpy.mockRestore();
  });

  it('refreshIdentity ignores identity inherited from a matching connection', async () => {
    const state = loadState();
    const existing = addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
      orgKey: 'my-org',
      tokenName: 'browser-token-name',
    });
    existing.userUuid = 'old-user';
    existing.organizationUuidV4 = 'old-org';
    existing.enterpriseUuid = null;
    writeStateFixture(state);

    const getSafeSpy = mockIdentityGetSafe({
      user: [{ ok: true, id: 'new-user' }],
      org: [{ ok: true, uuidV4: 'new-org' }],
    });

    const connection = await recordConnectionFromAuth(cloudAuth('replacement-token'), {
      force: true,
      refreshIdentity: true,
    });

    expect(connection.tokenName).toBeUndefined();
    expect(connection.userUuid).toBe('new-user');
    expect(connection.organizationUuidV4).toBe('new-org');
    getSafeSpy.mockRestore();
  });

  it('sets organizationUuidV4 only for cloud auth with an org key, and sqsInstallationId only for on-premise', async () => {
    const getSafeSpy = mockIdentityGetSafe({
      user: [{ ok: true, id: 'user-a' }],
      status: [{ ok: true, id: 'sqs-a' }],
    });

    const onPremConnection = await recordConnectionFromAuth(serverAuth('t5'));
    expect(onPremConnection.sqsInstallationId).toBe('sqs-a');
    expect(onPremConnection.organizationUuidV4).toBeUndefined();
    expect(onPremConnection.enterpriseUuid).toBeUndefined();

    getSafeSpy.mockRestore();
  });

  it('rejects env-var auth', () => {
    const envAuth = new ResolvedAuth({
      token: 'env-token',
      serverUrl: 'https://sq.example.com',
      connectionType: 'on-premise',
      source: 'env',
    });

    return expect(recordConnectionFromAuth(envAuth)).rejects.toThrow(
      'recordConnectionFromAuth must not be called for env-var auth',
    );
  });

  it('persists enterpriseUuid for cloud auth with an org key', async () => {
    const getSafeSpy = mockIdentityGetSafe({
      user: [{ ok: true, id: 'user-a' }],
      org: [{ ok: true, uuidV4: 'org-a', id: 'legacy-org-a' }],
      enterprise: [{ ok: true, enterpriseId: 'ent-a' }],
    });

    const connection = await recordConnectionFromAuth(cloudAuth('t-ent'));

    expect(connection.organizationUuidV4).toBe('org-a');
    expect(connection.enterpriseUuid).toBe('ent-a');
    expect(connection.sqsInstallationId).toBeUndefined();
    getSafeSpy.mockRestore();
  });

  it('does not persist enterpriseUuid when the enterprise lookup fails transiently', async () => {
    const getSafeSpy = mockIdentityGetSafe({
      user: [{ ok: true, id: 'user-a' }],
      org: [{ ok: true, uuidV4: 'org-a', id: 'legacy-org-a' }],
      enterprise: [{ ok: false }],
    });

    const connection = await recordConnectionFromAuth(cloudAuth('t-ent-fail'));

    expect(connection.organizationUuidV4).toBe('org-a');
    expect(connection.enterpriseUuid).toBeUndefined();
    getSafeSpy.mockRestore();
  });
});

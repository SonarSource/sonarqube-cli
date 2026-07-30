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
 * Unit tests for telemetry/identity.ts pure helpers and the disk/env/API
 * enrichment layering in resolveTelemetryIdentity / resolveCommandTelemetryIdentity.
 * Every test uses a unique token and isolated SONAR_USER_HOME to avoid cross-test
 * disk-cache hits.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import * as authResolver from '@/core/auth/auth-resolver.ts';
import { ENV_SONAR_USER_HOME, getTelemetryDir } from '@/core/config-constants.ts';
import { resolveTelemetryIdentity } from '@/core/host/identity-fetch.ts';
import type { AuthConnection } from '@/core/state/state.ts';
import {
  identityFromConnection,
  isIdentityCompleteForConnection,
  resolveCommandTelemetryIdentity,
  resolveStoreEventTelemetryIdentitySafely,
} from '@/core/telemetry/identity.ts';

import { mockIdentityGetSafe } from './identity-api-mock.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cloudAuth(token: string, orgKey = 'my-org'): ResolvedAuth {
  return { token, serverUrl: 'https://sonarcloud.io', orgKey, connectionType: 'cloud' };
}

function serverAuth(token: string): ResolvedAuth {
  return { token, serverUrl: 'https://sq.example.com', connectionType: 'on-premise' };
}

function cloudConn(overrides: Partial<AuthConnection> = {}): AuthConnection {
  return {
    id: 'conn-cloud',
    type: 'cloud',
    serverUrl: 'https://sonarcloud.io',
    orgKey: 'my-org',
    authenticatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Replicates identity.ts#cacheKey so tests can seed the disk cache directly. */
function cacheKey(auth: ResolvedAuth): string {
  const fingerprint = createHash('sha256').update(auth.token).digest('hex').slice(0, 16);
  return [auth.connectionType, auth.serverUrl, auth.orgKey ?? '', fingerprint].join('|');
}

function seedDiskCache(auth: ResolvedAuth, entry: Record<string, unknown>): void {
  mkdirSync(getTelemetryDir(), { recursive: true });
  writeFileSync(
    join(getTelemetryDir(), 'identity-cache.json'),
    JSON.stringify({ entries: { [cacheKey(auth)]: entry } }),
  );
}

function writeRawCache(contents: string): void {
  mkdirSync(getTelemetryDir(), { recursive: true });
  writeFileSync(join(getTelemetryDir(), 'identity-cache.json'), contents);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'identity-test-'));
  process.env[ENV_SONAR_USER_HOME] = testDir;
});

afterEach(() => {
  delete process.env[ENV_SONAR_USER_HOME];
  rmSync(testDir, { recursive: true, force: true });
});

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe('identityFromConnection()', () => {
  it('returns all-null identity when the connection is undefined', () => {
    expect(identityFromConnection(undefined)).toEqual({
      user_uuid: null,
      organization_uuid_v4: null,
      sqs_installation_id: null,
    });
  });

  it('maps connection UUID fields into the identity payload', () => {
    const identity = identityFromConnection(
      cloudConn({ userUuid: 'u', organizationUuidV4: 'o', sqsInstallationId: 's' }),
    );
    expect(identity).toEqual({
      user_uuid: 'u',
      organization_uuid_v4: 'o',
      sqs_installation_id: 's',
    });
  });
});

describe('isIdentityCompleteForConnection()', () => {
  it('requires user_uuid for cloud', () => {
    expect(
      isIdentityCompleteForConnection(
        { user_uuid: null, organization_uuid_v4: 'o', sqs_installation_id: null },
        'cloud',
      ),
    ).toBe(false);
  });

  it('requires organization_uuid_v4 for cloud', () => {
    expect(
      isIdentityCompleteForConnection(
        { user_uuid: 'u', organization_uuid_v4: null, sqs_installation_id: null },
        'cloud',
      ),
    ).toBe(false);
    expect(
      isIdentityCompleteForConnection(
        { user_uuid: 'u', organization_uuid_v4: 'o', sqs_installation_id: null },
        'cloud',
      ),
    ).toBe(true);
  });

  it('requires sqs_installation_id for on-premise', () => {
    expect(
      isIdentityCompleteForConnection(
        { user_uuid: null, organization_uuid_v4: null, sqs_installation_id: null },
        'on-premise',
      ),
    ).toBe(false);
    expect(
      isIdentityCompleteForConnection(
        { user_uuid: null, organization_uuid_v4: null, sqs_installation_id: 's' },
        'on-premise',
      ),
    ).toBe(true);
  });
});

describe('resolveStoreEventTelemetryIdentitySafely()', () => {
  it('falls back to the connection identity when enrichment throws', async () => {
    const conn = cloudConn({ userUuid: 'u' });
    const resolveFromStateSpy = spyOn(authResolver, 'resolveFromState').mockRejectedValue(
      new Error('keychain locked'),
    );

    const result = await resolveStoreEventTelemetryIdentitySafely(conn);

    expect(result.connectionType).toBe('sqc');
    expect(result.identity.user_uuid).toBe('u');
    resolveFromStateSpy.mockRestore();
  });
});

// ─── resolveCommandTelemetryIdentity ───────────────────────────────────────────

describe('resolveCommandTelemetryIdentity()', () => {
  it('uses the connection identity without enrichment when auth is null', async () => {
    const conn = cloudConn({ userUuid: 'u', organizationUuidV4: 'o' });
    const getSafeSpy = mockIdentityGetSafe();

    const { connectionType, identity } = await resolveCommandTelemetryIdentity(conn, null);

    expect(connectionType).toBe('sqc');
    expect(identity.user_uuid).toBe('u');
    expect(getSafeSpy).not.toHaveBeenCalled();
    getSafeSpy.mockRestore();
  });

  it('maps on-premise auth to sqs and skips enrichment when the connection is complete', async () => {
    const conn: AuthConnection = {
      id: 'c',
      type: 'on-premise',
      serverUrl: 'https://sq.example.com',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
      sqsInstallationId: 's',
      userUuid: 'server-user',
    };
    const getSafeSpy = mockIdentityGetSafe();

    const { connectionType, identity } = await resolveCommandTelemetryIdentity(
      conn,
      serverAuth('sqs-complete-token'),
    );

    expect(connectionType).toBe('sqs');
    expect(identity.sqs_installation_id).toBe('s');
    expect(identity.user_uuid).toBe('server-user');
    expect(getSafeSpy).not.toHaveBeenCalled();
    getSafeSpy.mockRestore();
  });

  it('ignores a connection that does not match the resolved auth', async () => {
    const conn = cloudConn({ userUuid: 'stale-user', serverUrl: 'https://other.io' });
    const getSafeSpy = mockIdentityGetSafe({
      user: [{ ok: true, id: 'fresh-user' }],
      org: [{ ok: true, uuidV4: 'fresh-org' }],
    });

    const { identity } = await resolveCommandTelemetryIdentity(
      conn,
      cloudAuth('cmd-mismatch-token'),
    );

    expect(identity.user_uuid).toBe('fresh-user');
    getSafeSpy.mockRestore();
  });
});

// ─── resolveTelemetryIdentity ──────────────────────────────────────────────────

describe('resolveTelemetryIdentity()', () => {
  it('resolves the SQS installation id from system status for on-premise auth', async () => {
    const getSafeSpy = mockIdentityGetSafe({
      status: [{ ok: true, id: 'sqs-abc' }],
      user: [{ ok: true, id: 'sqs-user' }],
    });

    const identity = await resolveTelemetryIdentity(serverAuth('sqs-token-1'));

    expect(identity.user_uuid).toBe('sqs-user');
    expect(identity.sqs_installation_id).toBe('sqs-abc');
    getSafeSpy.mockRestore();
  });

  it('fetches user_uuid for on-premise auth when available', async () => {
    const getSafeSpy = mockIdentityGetSafe({
      status: [{ ok: true, id: 'sqs-only' }],
      user: [{ ok: true, id: 'sqs-user-id' }],
    });

    const identity = await resolveTelemetryIdentity(serverAuth('sqs-token-with-user'));

    expect(identity.user_uuid).toBe('sqs-user-id');
    expect(
      getSafeSpy.mock.calls.filter((call: [string]) => call[0] === '/api/users/current'),
    ).toHaveLength(1);
    getSafeSpy.mockRestore();
  });

  it('leaves sqs_installation_id null when system status fails', async () => {
    const getSafeSpy = mockIdentityGetSafe({
      status: [{ ok: false }],
    });

    const identity = await resolveTelemetryIdentity(serverAuth('sqs-token-2'));

    expect(identity.sqs_installation_id).toBeNull();
    getSafeSpy.mockRestore();
  });

  it('serves a complete identity from the disk cache without hitting the API', async () => {
    const auth = cloudAuth('disk-complete-token');
    seedDiskCache(auth, { userUuid: 'disk-user', organizationUuidV4: 'disk-org' });

    const getSafeSpy = mockIdentityGetSafe();

    const identity = await resolveTelemetryIdentity(auth);

    expect(identity.user_uuid).toBe('disk-user');
    expect(identity.organization_uuid_v4).toBe('disk-org');
    expect(getSafeSpy).not.toHaveBeenCalled();
    getSafeSpy.mockRestore();
  });

  it('caches confirmed-absent organization_uuid and stops re-fetching', async () => {
    const auth = cloudAuth('org-absent-token');
    const getSafeSpy = mockIdentityGetSafe({
      user: [{ ok: true, id: 'cloud-user' }],
      org: [{ ok: true }],
    });

    await resolveTelemetryIdentity(auth);
    await resolveTelemetryIdentity(cloudAuth('org-absent-token'));

    expect(
      getSafeSpy.mock.calls.filter((call: [string]) => call[0] === '/organizations/organizations'),
    ).toHaveLength(1);
    getSafeSpy.mockRestore();
  });

  it('treats a malformed disk cache as empty and falls back to the API', async () => {
    writeRawCache('{ not valid json');
    const getSafeSpy = mockIdentityGetSafe({
      user: [{ ok: true, id: 'api-user' }],
      org: [{ ok: true, uuidV4: 'api-org' }],
    });

    const identity = await resolveTelemetryIdentity(cloudAuth('malformed-cache-token'));

    expect(identity.user_uuid).toBe('api-user');
    expect(getSafeSpy).toHaveBeenCalled();
    getSafeSpy.mockRestore();
  });

  it('treats a cache file without an entries object as empty', async () => {
    writeRawCache(JSON.stringify({ unexpected: true }));
    const getSafeSpy = mockIdentityGetSafe({
      user: [{ ok: true, id: 'api-user' }],
      org: [{ ok: true, uuidV4: 'api-org' }],
    });

    const identity = await resolveTelemetryIdentity(cloudAuth('no-entries-token'));

    expect(identity.user_uuid).toBe('api-user');
    expect(identity.organization_uuid_v4).toBe('api-org');
    getSafeSpy.mockRestore();
  });

  it('caches confirmed-absent user_uuid for cloud and stops re-fetching', async () => {
    const auth = cloudAuth('user-absent-token');
    const getSafeSpy = mockIdentityGetSafe({
      user: [{ ok: true }],
      org: [{ ok: true, uuidV4: 'cloud-org' }],
    });

    const first = await resolveTelemetryIdentity(auth);
    const second = await resolveTelemetryIdentity(cloudAuth('user-absent-token'));

    expect(first.user_uuid).toBeNull();
    expect(first.organization_uuid_v4).toBe('cloud-org');
    expect(second.user_uuid).toBeNull();
    expect(
      getSafeSpy.mock.calls.filter((call: [string]) => call[0] === '/api/users/current'),
    ).toHaveLength(1);
    getSafeSpy.mockRestore();
  });

  it('retries user_uuid fetch after a transient API failure', async () => {
    const auth = cloudAuth('transient-user-token');
    const getSafeSpy = mockIdentityGetSafe({
      user: [{ ok: false }, { ok: true, id: 'user-after-retry' }],
      org: [{ ok: true, uuidV4: 'cached-org' }],
    });

    const first = await resolveTelemetryIdentity(auth);
    const second = await resolveTelemetryIdentity(cloudAuth('transient-user-token'));

    expect(first.user_uuid).toBeNull();
    expect(second.user_uuid).toBe('user-after-retry');
    expect(
      getSafeSpy.mock.calls.filter((call: [string]) => call[0] === '/api/users/current'),
    ).toHaveLength(2);
    getSafeSpy.mockRestore();
  });

  it('treats on-premise identity as complete with only sqs_installation_id when login confirmed user absence', async () => {
    const conn: AuthConnection = {
      id: 'c',
      type: 'on-premise',
      serverUrl: 'https://sq.example.com',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
      sqsInstallationId: 'sqs-old-server',
      userUuid: null,
    };
    const getSafeSpy = mockIdentityGetSafe();

    const { connectionType, identity } = await resolveCommandTelemetryIdentity(
      conn,
      serverAuth('sqs-old-token'),
    );

    expect(connectionType).toBe('sqs');
    expect(identity.user_uuid).toBeNull();
    expect(identity.sqs_installation_id).toBe('sqs-old-server');
    expect(getSafeSpy).not.toHaveBeenCalled();
    getSafeSpy.mockRestore();
  });

  it('fetches user_uuid for on-premise when the connection has sqs but login never resolved user', async () => {
    const conn: AuthConnection = {
      id: 'c',
      type: 'on-premise',
      serverUrl: 'https://sq.example.com',
      authenticatedAt: '2026-01-01T00:00:00.000Z',
      sqsInstallationId: 'sqs-old-server',
    };
    const getSafeSpy = mockIdentityGetSafe({
      user: [{ ok: true, id: 'legacy-conn-user' }],
    });

    const { identity } = await resolveCommandTelemetryIdentity(
      conn,
      serverAuth('sqs-legacy-token'),
    );

    expect(identity.user_uuid).toBe('legacy-conn-user');
    expect(identity.sqs_installation_id).toBe('sqs-old-server');
    expect(
      getSafeSpy.mock.calls.filter((call: [string]) => call[0] === '/api/users/current'),
    ).toHaveLength(1);
    expect(
      getSafeSpy.mock.calls.filter((call: [string]) => call[0] === '/api/system/status'),
    ).toHaveLength(0);
    getSafeSpy.mockRestore();
  });

  it('caches sqs_installation_id for on-premise and does not re-fetch', async () => {
    const auth = serverAuth('sqs-cache-token');
    const getSafeSpy = mockIdentityGetSafe({
      status: [{ ok: true, id: 'sqs-cached' }],
    });

    await resolveTelemetryIdentity(auth);
    await resolveTelemetryIdentity(serverAuth('sqs-cache-token'));

    expect(
      getSafeSpy.mock.calls.filter((call: [string]) => call[0] === '/api/system/status'),
    ).toHaveLength(1);
    getSafeSpy.mockRestore();
  });
});

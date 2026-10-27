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
 * Tests for state manager (business logic) and state repository (filesystem I/O).
 * SONAR_USER_HOME env var redirects state paths to a temporary directory.
 */

import fs from 'node:fs';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { AuthConnection, CliState } from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';
import {
  addOrUpdateConnection,
  authMatchesConnection,
  generateConnectionId,
  removeConnection,
} from '@/core/state/state-manager.ts';
import {
  loadState,
  STATE_READ_MAX_ATTEMPTS,
  stateFileExists,
  tryLoadState,
  updateState,
} from '@/core/state/state-repository.ts';

const testSonarUserHome = join(tmpdir(), `sonar-cli-state-test-${Date.now()}`);
const testCliDir = join(testSonarUserHome, 'sonarqube-cli');
const testStateFile = join(testCliDir, 'state.json');

function writeStateFixture(state: CliState): void {
  updateState((latest) => {
    Object.assign(latest, state);
  });
}

process.env.SONAR_USER_HOME = testSonarUserHome;

afterAll(() => {
  delete process.env.SONAR_USER_HOME;
});

function cleanup(): void {
  if (existsSync(testCliDir)) {
    rmSync(testCliDir, { recursive: true, force: true });
  }
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

function serverAuth(token: string): ResolvedAuth {
  return new ResolvedAuth({
    token,
    serverUrl: 'https://sq.example.com',
    connectionType: 'on-premise',
    source: 'state',
  });
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

// =============================================================================
// State Manager — business logic
// =============================================================================

describe('State Manager', () => {
  describe('authMatchesConnection', () => {
    it('should match when server URL and org key align (cloud)', () => {
      expect(authMatchesConnection(cloudAuth('t'), cloudConn())).toBe(true);
    });

    it('should not match on a different server URL', () => {
      expect(
        authMatchesConnection(cloudAuth('t'), cloudConn({ serverUrl: 'https://other.io' })),
      ).toBe(false);
    });

    it('should not match on a different org key (cloud)', () => {
      expect(authMatchesConnection(cloudAuth('t'), cloudConn({ orgKey: 'different' }))).toBe(false);
    });

    it('should ignore org key for on-premise connections', () => {
      const conn: AuthConnection = {
        id: 'c',
        type: 'on-premise',
        serverUrl: 'https://sq.example.com',
        authenticatedAt: '2026-01-01T00:00:00.000Z',
      };
      expect(authMatchesConnection(serverAuth('t'), conn)).toBe(true);
    });
  });

  describe('generateConnectionId', () => {
    it('should generate consistent hash for same input', () => {
      const id1 = generateConnectionId('https://sonarcloud.io', 'my-org');
      const id2 = generateConnectionId('https://sonarcloud.io', 'my-org');

      expect(id1).toBe(id2);
    });

    it('should generate different hash for different inputs', () => {
      const id1 = generateConnectionId('https://sonarcloud.io', 'my-org');
      const id2 = generateConnectionId('https://sonarcloud.io', 'other-org');

      expect(id1).not.toBe(id2);
    });

    it('should generate a non-empty string for on-premise without orgKey', () => {
      const id = generateConnectionId('https://sonar.internal.company.com');
      expect(id.length).toBeGreaterThan(0);
      expect(id).not.toBe(generateConnectionId('https://sonar.other.com'));
    });
  });

  describe('addOrUpdateConnection', () => {
    it('should add new cloud connection', () => {
      const state = getDefaultState('0.2.61');
      const connection = addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
        region: 'eu',
      });

      expect(connection.type).toBe('cloud');
      expect(connection.orgKey).toBe('my-org');
      expect(connection.region).toBe('eu');
      expect(state.auth.connections).toHaveLength(1);
      expect(state.auth.isAuthenticated).toBe(true);
      expect(state.auth.activeConnectionId).toBe(connection.id);
    });

    it('should add on-premise connection', () => {
      const state = getDefaultState('0.2.61');
      const connection = addOrUpdateConnection(state, 'https://sonar.internal.com', 'on-premise');

      expect(connection.type).toBe('on-premise');
      expect(connection.orgKey).toBeUndefined();
      expect(connection.region).toBeUndefined();
    });

    it('should update existing connection', () => {
      const state = getDefaultState('0.2.61');
      const conn1 = addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
        region: 'eu',
      });

      const conn2 = addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
        region: 'us',
      });

      expect(conn1.id).toBe(conn2.id);
      expect(state.auth.connections).toHaveLength(1);
      expect(state.auth.connections[0].region).toBe('us');
    });
  });

  describe('single connection support', () => {
    it('replaces existing connection when a different server is added', () => {
      const state = getDefaultState('0.2.61');

      const conn1 = addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
        region: 'eu',
      });
      expect(state.auth.connections).toHaveLength(1);
      expect(state.auth.isAuthenticated).toBe(true);

      // cloud → on-premise
      const conn2 = addOrUpdateConnection(state, 'https://sonar.company.com', 'on-premise');

      expect(state.auth.connections).toHaveLength(1);
      expect(state.auth.connections[0].serverUrl).toBe('https://sonar.company.com');
      expect(state.auth.connections[0].type).toBe('on-premise');
      expect(state.auth.activeConnectionId).toBe(conn2.id);
      expect(state.auth.isAuthenticated).toBe(true);
      expect(conn1.id).not.toBe(conn2.id);

      // on-premise → cloud
      const conn3 = addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'sonarsource',
        region: 'us',
      });

      expect(state.auth.connections).toHaveLength(1);
      expect(state.auth.connections[0].type).toBe('cloud');
      expect(state.auth.connections[0].orgKey).toBe('sonarsource');
      expect(state.auth.activeConnectionId).toBe(conn3.id);
      expect(state.auth.isAuthenticated).toBe(true);
    });
  });
});

// =============================================================================
// State Repository — filesystem I/O
// =============================================================================

describe('loadState: filesystem I/O', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('creates state dir and returns default state when file does not exist', () => {
    const state = loadState('0.1.0');
    expect(existsSync(testCliDir)).toBe(true);
    expect(state.config.cliVersion).toBe('0.1.0');
    expect(state.auth.isAuthenticated).toBe(false);
  });

  it('returns parsed state when valid state file exists', () => {
    const initial = getDefaultState('0.3.0');
    initial.auth.isAuthenticated = true;
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(initial), 'utf-8');
    const state = loadState('0.3.0');
    expect(state.auth.isAuthenticated).toBe(true);
  });
});

describe('tryLoadState', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('returns parsed state for a valid file', () => {
    const initial = getDefaultState('0.3.0');
    initial.auth.isAuthenticated = true;
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(initial), 'utf-8');

    const state = tryLoadState('0.3.0');

    expect(state?.auth.isAuthenticated).toBe(true);
  });

  it('returns null for a corrupt file', () => {
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, 'not-valid-json', 'utf-8');

    expect(tryLoadState('0.2.0')).toBeNull();
    // And the corrupt file remains untouched.
    expect(readFileSync(testStateFile, 'utf-8')).toBe('not-valid-json');
  });
});

describe('loadState: retry on transient read failure', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('recovers when an early read fails transiently, then succeeds', () => {
    const initial = getDefaultState('0.4.0');
    initial.auth.isAuthenticated = true;
    const content = JSON.stringify(initial);
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, content, 'utf-8');

    // Fail the first read, then return the real file contents.
    const readSpy = spyOn(fs, 'readFileSync')
      .mockImplementationOnce(() => {
        throw new Error('read failed');
      })
      .mockReturnValue(content);

    try {
      const state = loadState('0.4.0');
      expect(state.auth.isAuthenticated).toBe(true);
      expect(readSpy).toHaveBeenCalledTimes(2);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('retries exactly STATE_READ_MAX_ATTEMPTS times before throwing', () => {
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(getDefaultState('0.4.0')), 'utf-8');

    const readSpy = spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('read failed');
    });

    try {
      expect(() => loadState('0.4.0')).toThrow(/Failed to read state/);
      expect(readSpy).toHaveBeenCalledTimes(STATE_READ_MAX_ATTEMPTS);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('memoizes the failure so a persistently corrupt file is only retried once per process (CLI-834)', () => {
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, 'not-valid-json', 'utf-8');

    const readSpy = spyOn(fs, 'readFileSync');

    try {
      expect(() => loadState('0.4.0')).toThrow(/Failed to read state/);
      // Second call at another call site must reuse the cached failure, not retry.
      expect(() => loadState('0.4.0')).toThrow(/Failed to read state/);
      expect(readSpy).toHaveBeenCalledTimes(STATE_READ_MAX_ATTEMPTS);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('retries fresh once the file is rewritten (fingerprint changes)', () => {
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, 'not-valid-json', 'utf-8');

    expect(() => loadState('0.4.0')).toThrow(/Failed to read state/);

    // Overwrite with a valid file: a later read must not reuse the cached failure.
    const recovered = getDefaultState('0.4.0');
    recovered.auth.isAuthenticated = true;
    writeFileSync(testStateFile, JSON.stringify(recovered), 'utf-8');

    const state = loadState('0.4.0');
    expect(state.auth.isAuthenticated).toBe(true);
  });
});

describe('loadState: migration', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('preserves existing state data when auth object is absent in state file', () => {
    // Arrange: state file missing auth but with a known telemetry installationId.
    // Without the B3 guard migrateState crashes at state.auth.connections, the catch
    // block returns getDefaultState() — discarding all saved data including installationId.
    const raw = getDefaultState('0.1.0') as unknown as Record<string, unknown>;
    delete raw['auth'];
    (raw['telemetry'] as Record<string, unknown>)['installationId'] = 'preserved-id-b3';
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(raw), 'utf-8');

    // Act
    const state = loadState('0.1.0');

    // Assert: state was migrated (not discarded), so saved installationId is preserved
    expect(state.telemetry.installationId).toBe('preserved-id-b3');
    // auth was initialised to safe defaults
    expect(state.auth).toBeDefined();
    expect(state.auth.isAuthenticated).toBe(false);
  });

  it('initialises agentExtensions to empty array when absent in state file', () => {
    const raw = getDefaultState('0.1.0') as unknown as Record<string, unknown>;
    delete raw['agentExtensions'];
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(raw), 'utf-8');

    const state = loadState('0.1.0');

    expect(state.agentExtensions).toEqual([]);
  });

  it('initialises integrations to empty installed list when absent in state file', () => {
    const raw = getDefaultState('0.1.0') as unknown as Record<string, unknown>;
    delete raw['integrations'];
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(raw), 'utf-8');

    const state = loadState('0.1.0');

    expect(state.integrations).toEqual({ installed: [] });
  });

  it('initialises dependencies to empty installed list when absent in state file', () => {
    const raw = getDefaultState('0.1.0') as unknown as Record<string, unknown>;
    delete raw['dependencies'];
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(raw), 'utf-8');

    const state = loadState('0.1.0');

    expect(state.dependencies).toEqual({ installed: [] });
  });

  it('initialises telemetry when absent in state file', () => {
    const raw = getDefaultState('0.1.0') as unknown as Record<string, unknown>;
    delete raw['telemetry'];
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(raw), 'utf-8');

    const state = loadState('0.1.0');

    expect(state.telemetry.installationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not backfill stats when absent in state file', () => {
    const raw = getDefaultState('0.1.0') as unknown as Record<string, unknown>;
    delete raw['stats'];
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(raw), 'utf-8');

    const state = loadState('0.1.0');

    expect(state.stats).toBeUndefined();
  });

  it('drops legacy envOnly connections and clears auth when none remain', () => {
    const raw = getDefaultState('0.1.0') as unknown as Record<string, unknown>;
    raw.auth = {
      isAuthenticated: true,
      activeConnectionId: 'env-only-conn',
      connections: [
        {
          id: 'env-only-conn',
          type: 'on-premise',
          serverUrl: 'https://env.example.com',
          authenticatedAt: '2026-01-01T00:00:00.000Z',
          envOnly: true,
        },
      ],
    };
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(raw), 'utf-8');

    const state = loadState('0.1.0');

    expect(state.auth.isAuthenticated).toBe(false);
    expect(state.auth.connections).toHaveLength(0);
    expect(state.auth.activeConnectionId).toBeUndefined();
  });

  it('keeps keychain connections and repoints activeConnectionId away from legacy envOnly', () => {
    const raw = getDefaultState('0.1.0') as unknown as Record<string, unknown>;
    raw.auth = {
      isAuthenticated: true,
      activeConnectionId: 'env-only-conn',
      connections: [
        {
          id: 'env-only-conn',
          type: 'on-premise',
          serverUrl: 'https://env.example.com',
          authenticatedAt: '2026-01-01T00:00:00.000Z',
          envOnly: true,
        },
        {
          id: 'login-conn',
          type: 'on-premise',
          serverUrl: 'https://login.example.com',
          authenticatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    };
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(raw), 'utf-8');

    const state = loadState('0.1.0');

    expect(state.auth.connections).toHaveLength(1);
    expect(state.auth.connections[0]?.id).toBe('login-conn');
    expect(state.auth.activeConnectionId).toBe('login-conn');
    expect(state.auth.isAuthenticated).toBe(true);
    expect(state.auth.connections[0]).not.toHaveProperty('envOnly');
  });

  it('adopts a legacy tools entry whose binary is still on disk', () => {
    mkdirSync(testCliDir, { recursive: true });
    const binaryPath = join(testCliDir, 'sonar-secrets-1.2.3.4-linux-x86-64');
    writeFileSync(binaryPath, 'binary', 'utf-8');
    const raw = getDefaultState('0.1.0') as unknown as Record<string, unknown>;
    raw['tools'] = {
      installed: [
        {
          name: 'sonar-secrets',
          version: '1.2.3.4',
          path: binaryPath,
          installedAt: '2026-01-01T00:00:00.000Z',
          installedByCliVersion: '0.1.0',
        },
      ],
    };
    writeFileSync(testStateFile, JSON.stringify(raw), 'utf-8');

    const state = loadState('0.1.0');

    expect(state.dependencies.installed).toEqual([
      {
        id: 'sonar-secrets',
        version: '1.2.3.4',
        path: binaryPath,
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '0.1.0',
      },
    ]);
    expect(state.tools).toBeUndefined();
  });

  it('drops a legacy tools entry whose binary is gone and keeps the dependency record on conflict', () => {
    mkdirSync(testCliDir, { recursive: true });
    const raw = getDefaultState('0.1.0') as unknown as Record<string, unknown>;
    raw['dependencies'] = {
      installed: [
        {
          id: 'sonar-secrets',
          version: '9.9.9.9',
          path: '/bin/sonar-secrets-9.9.9.9',
          updatedAt: '2026-02-02T00:00:00.000Z',
          updatedByCliVersion: '0.2.0',
        },
      ],
    };
    raw['tools'] = {
      installed: [
        {
          name: 'sonar-secrets',
          version: '1.1.1.1',
          path: '/bin/sonar-secrets-1.1.1.1',
          installedAt: '2026-01-01T00:00:00.000Z',
          installedByCliVersion: '0.1.0',
        },
        {
          name: 'sca-scanner-cli',
          version: '1.0.0.0',
          path: join(testCliDir, 'sca-scanner-cli-gone'),
          installedAt: '2026-01-01T00:00:00.000Z',
          installedByCliVersion: '0.1.0',
        },
      ],
    };
    writeFileSync(testStateFile, JSON.stringify(raw), 'utf-8');

    const state = loadState('0.1.0');

    expect(state.dependencies.installed).toHaveLength(1);
    expect(state.dependencies.installed[0].version).toBe('9.9.9.9');
    expect(state.tools).toBeUndefined();
  });

  it('backfills the array fields of an installed feature written without them', () => {
    mkdirSync(testCliDir, { recursive: true });
    const raw = getDefaultState('0.1.0') as unknown as Record<string, unknown>;
    raw['integrations'] = {
      installed: [
        {
          id: 'claude',
          integrationId: 'claude',
          features: [
            {
              featureId: 'mcp-server',
              scope: 'global',
              targetRoot: '/home/user',
              installedByCliVersion: '0.1.0',
              installedAt: '2026-01-01T00:00:00.000Z',
              updatedByCliVersion: '0.1.0',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
        { id: 'git', integrationId: 'git' },
      ],
    };
    writeFileSync(testStateFile, JSON.stringify(raw), 'utf-8');

    const state = loadState('0.1.0');

    const feature = state.integrations.installed[0].features[0];
    expect(feature.resources).toEqual([]);
    expect(feature.dependencies).toEqual([]);
    expect(feature.operations).toEqual([]);
    expect(state.integrations.installed[1].features).toEqual([]);
  });

  it('preserves missing legacy agent state', () => {
    const raw = getDefaultState('0.1.0') as unknown as Record<string, unknown>;
    delete raw['agents'];
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(raw), 'utf-8');

    const state = loadState('0.1.0');

    expect(state.agents).toBeUndefined();
  });

  it('removes legacy keystoreKey field from connections', () => {
    const raw = getDefaultState('0.1.0') as unknown as Record<string, unknown>;
    (raw['auth'] as Record<string, unknown>)['connections'] = [
      {
        id: 'conn-1',
        type: 'on-premise',
        serverUrl: 'https://sonar.internal.com',
        authenticatedAt: new Date().toISOString(),
        keystoreKey: 'legacy-key-to-strip',
      },
    ];
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(raw), 'utf-8');

    const state = loadState('0.1.0');

    expect('keystoreKey' in state.auth.connections[0]).toBe(false);
    expect(state.auth.connections[0].serverUrl).toBe('https://sonar.internal.com');
  });
});

// =============================================================================
// stateFileExists
// =============================================================================

describe('stateFileExists', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('returns false when state file does not exist', () => {
    expect(stateFileExists()).toBe(false);
  });

  it('returns true when state file exists', () => {
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(getDefaultState('1.0.0')), 'utf-8');

    expect(stateFileExists()).toBe(true);
  });
});

// =============================================================================
// updateState — filesystem I/O
// =============================================================================

describe('updateState', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('writes state to disk and preserves data across a load cycle', () => {
    const before = new Date().toISOString();
    const state = getDefaultState('1.0.0');
    state.auth.isAuthenticated = true;

    writeStateFixture(state);

    const loaded = loadState('1.0.0');
    expect(loaded.auth.isAuthenticated).toBe(true);
    expect(loaded.lastUpdated >= before).toBe(true);
  });

  it('throws when the state file cannot be replaced', () => {
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('replacement denied');
    });
    try {
      expect(() => writeStateFixture(getDefaultState('1.0.0'))).toThrow('replacement denied');
    } finally {
      renameSpy.mockRestore();
    }
    expect(existsSync(testStateFile)).toBe(false);
  });

  it('retries a transient state replacement failure', () => {
    const rename = fs.renameSync.bind(fs);
    let attempts = 0;
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      attempts++;
      if (attempts <= 2) {
        throw Object.assign(new Error('file is busy'), { code: 'EPERM' });
      }
      rename(from, to);
    });

    try {
      writeStateFixture(getDefaultState('1.0.0'));
      expect(renameSpy).toHaveBeenCalledTimes(3);
    } finally {
      renameSpy.mockRestore();
    }
    expect(loadState().config.cliVersion).toBe('1.0.0');
  });

  it('preserves state and the corrupt lock until processes are stopped for repair', () => {
    writeStateFixture(getDefaultState('1.0.0'));
    const lockFile = `${testStateFile}.lock.sqlite`;
    writeFileSync(lockFile, 'not a database');
    let updateRan = false;
    let failure: unknown;
    try {
      updateState((state) => {
        updateRan = true;
        state.config.cliVersion = '2.0.0';
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CommandFailedError);
    expect((failure as CommandFailedError).message).toContain(lockFile);
    expect((failure as CommandFailedError).message).toContain(
      'Stop all sonar CLI processes. Remove the corrupt lock file, then retry.',
    );
    expect(updateRan).toBe(false);
    expect(readFileSync(lockFile, 'utf-8')).toBe('not a database');
    expect(loadState().config.cliVersion).toBe('1.0.0');

    rmSync(lockFile);
    updateState((state) => {
      state.config.cliVersion = '2.0.0';
    });
    expect(loadState().config.cliVersion).toBe('2.0.0');
  });

  it('applies each update to the latest state', () => {
    updateState((state) => {
      addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', { orgKey: 'my-org' });
    });
    updateState((state) => {
      state.dependencies.installed.push({
        id: 'sonar-secrets',
        version: '1.0.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '1.0.0',
      });
    });

    const loaded = loadState();
    expect(loaded.auth.isAuthenticated).toBe(true);
    expect(loaded.dependencies.installed.map((dependency) => dependency.id)).toEqual([
      'sonar-secrets',
    ]);
  });

  it('preserves independent entries in the same registry', () => {
    for (const id of ['sonar-secrets', 'sca-scanner-cli']) {
      updateState((state) => {
        state.dependencies.installed.push({
          id,
          updatedAt: '2026-01-01',
          updatedByCliVersion: '1.0.0',
        });
      });
    }

    expect(loadState().dependencies.installed.map((dependency) => dependency.id)).toEqual([
      'sonar-secrets',
      'sca-scanner-cli',
    ]);
  });

  it('leaves the file intact when an update callback fails', () => {
    writeStateFixture(getDefaultState('1.0.0'));
    expect(() =>
      updateState((state) => {
        state.config.cliVersion = '2.0.0';
        throw new Error('update failed');
      }),
    ).toThrow('update failed');
    expect(loadState().config.cliVersion).toBe('1.0.0');
  });

  it('keeps the old file readable if replacement is interrupted', () => {
    writeStateFixture(getDefaultState('1.0.0'));
    const changed = loadState();
    changed.config.cliVersion = '2.0.0';
    const renameSpy = spyOn(fs, 'renameSync').mockImplementation(() => {
      expect(loadState().config.cliVersion).toBe('1.0.0');
      throw new Error('interrupted');
    });

    try {
      expect(() => writeStateFixture(changed)).toThrow('interrupted');
    } finally {
      renameSpy.mockRestore();
    }

    expect(loadState().config.cliVersion).toBe('1.0.0');
    expect(fs.readdirSync(testCliDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('releases an uncommitted state lock when its owner exits', async () => {
    writeStateFixture(getDefaultState('1.0.0'));
    const lockFile = `${testStateFile}.lock.sqlite`;
    const readyFile = join(testCliDir, 'lock-ready');
    const exitFile = join(testCliDir, 'lock-owner-exit-time');
    const owner = Bun.spawn([
      process.execPath,
      '-e',
      `
        import fs from 'node:fs';
        import { Database } from 'bun:sqlite';
        const db = new Database(${JSON.stringify(lockFile)}, { create: true });
        db.run('BEGIN IMMEDIATE');
        fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
        Bun.sleepSync(750);
        fs.writeFileSync(${JSON.stringify(exitFile)}, String(Date.now()));
        process.exit(0);
      `,
    ]);
    const deadline = Date.now() + 5_000;
    while (!existsSync(readyFile)) {
      if (Date.now() > deadline) throw new Error('Lock owner did not start');
      Bun.sleepSync(5);
    }

    const state = loadState();
    state.config.cliVersion = '2.0.0';
    writeStateFixture(state);
    const saveEnd = Date.now();

    expect(await owner.exited).toBe(0);
    expect(saveEnd).toBeGreaterThan(Number(readFileSync(exitFile, 'utf-8')));
    expect(loadState().config.cliVersion).toBe('2.0.0');
  });

  it('preserves both changes from processes that load the same version', async () => {
    writeStateFixture(getDefaultState('1.0.0'));
    const repositoryModule = join(
      import.meta.dir,
      '../../../../src/core/state/state-repository.ts',
    );
    const readyDir = join(testCliDir, 'ready');
    mkdirSync(readyDir);

    const startWorker = (name: string, other: string) => {
      const code = `
        import fs from 'node:fs';
        import { join } from 'node:path';
        import { updateState } from ${JSON.stringify(repositoryModule)};
        fs.writeFileSync(join(${JSON.stringify(readyDir)}, ${JSON.stringify(name)}), 'ready');
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(join(${JSON.stringify(readyDir)}, ${JSON.stringify(other)}))) {
          if (Date.now() > deadline) throw new Error('Other writer did not start');
          Bun.sleepSync(5);
        }
        updateState((state) => {
          state.config.betaCommandWarnings = { ...state.config.betaCommandWarnings, [${JSON.stringify(name)}]: '1.0.0' };
        });
      `;
      return Bun.spawn([process.execPath, '-e', code], {
        env: { ...process.env, SONAR_USER_HOME: testSonarUserHome },
      });
    };

    const first = startWorker('first', 'second');
    const second = startWorker('second', 'first');
    expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
    expect(loadState().config.betaCommandWarnings).toEqual({ first: '1.0.0', second: '1.0.0' });
  });

  it('preserves every key from repeated concurrent process writes', async () => {
    const processCount = 6;
    const writesPerProcess = 30;
    writeStateFixture(getDefaultState('1.0.0'));
    const repositoryModule = join(
      import.meta.dir,
      '../../../../src/core/state/state-repository.ts',
    );
    const readyDir = join(testCliDir, 'stress-ready');
    const startFile = join(testCliDir, 'stress-start');
    mkdirSync(readyDir);

    const workers = Array.from({ length: processCount }, (_, worker) => {
      const code = `
        import fs from 'node:fs';
        import { join } from 'node:path';
        import { updateState } from ${JSON.stringify(repositoryModule)};
        fs.writeFileSync(join(${JSON.stringify(readyDir)}, ${JSON.stringify(String(worker))}), 'ready');
        while (!fs.existsSync(${JSON.stringify(startFile)})) Bun.sleepSync(5);
        for (let iteration = 0; iteration < ${writesPerProcess}; iteration++) {
          updateState((state) => {
            state.config.betaCommandWarnings = {
              ...state.config.betaCommandWarnings,
              [String(${worker}) + '-' + String(iteration)]: '1.0.0',
            };
          });
        }
      `;
      return Bun.spawn([process.execPath, '-e', code], {
        env: { ...process.env, SONAR_USER_HOME: testSonarUserHome },
      });
    });
    const deadline = Date.now() + 10_000;
    while (fs.readdirSync(readyDir).length < processCount) {
      if (Date.now() > deadline) throw new Error('Stress writers did not start');
      Bun.sleepSync(5);
    }
    writeFileSync(startFile, 'start');

    expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual(
      Array.from({ length: processCount }, () => 0),
    );
    const keys = Object.keys(loadState().config.betaCommandWarnings ?? {});
    expect(keys).toHaveLength(processCount * writesPerProcess);
  }, 30_000);
});

// =============================================================================
// removeConnection
// =============================================================================

describe('removeConnection', () => {
  it('removes the specified connection and clears active state when it was active', () => {
    const state = getDefaultState('1.0.0');
    const conn = addOrUpdateConnection(state, 'https://sonar.internal.com', 'on-premise');

    removeConnection(state, conn.id);

    expect(state.auth.connections).toHaveLength(0);
    expect(state.auth.activeConnectionId).toBeUndefined();
    expect(state.auth.isAuthenticated).toBe(false);
  });

  it('does not clear active state when a different connection is removed', () => {
    const state = getDefaultState('1.0.0');
    const conn = addOrUpdateConnection(state, 'https://sonar.internal.com', 'on-premise');

    removeConnection(state, 'non-existent-id');

    expect(state.auth.connections).toHaveLength(1);
    expect(state.auth.activeConnectionId).toBe(conn.id);
    expect(state.auth.isAuthenticated).toBe(true);
  });
});

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

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  loadState,
  saveState,
  stateFileExists,
} from '../../../src/lib/repository/state-repository.js';
import { getDefaultState } from '../../../src/lib/state.js';
import {
  addOrUpdateConnection,
  generateConnectionId,
  removeConnection,
} from '../../../src/lib/state-manager.js';

const testSonarUserHome = join(tmpdir(), `sonar-cli-state-test-${Date.now()}`);
const testCliDir = join(testSonarUserHome, 'sonarqube-cli');
const testStateFile = join(testCliDir, 'state.json');

process.env.SONAR_USER_HOME = testSonarUserHome;

afterAll(() => {
  delete process.env.SONAR_USER_HOME;
});

function cleanup(): void {
  if (existsSync(testCliDir)) {
    rmSync(testCliDir, { recursive: true, force: true });
  }
}

// =============================================================================
// State Manager — business logic
// =============================================================================

describe('State Manager', () => {
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

  it('returns default state when file contains invalid JSON', () => {
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, 'not-valid-json', 'utf-8');
    const state = loadState('0.2.0');
    expect(state.config.cliVersion).toBe('0.2.0');
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
// saveState — filesystem I/O
// =============================================================================

describe('saveState', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('writes state to disk and preserves data across a load cycle', () => {
    const before = new Date().toISOString();
    const state = getDefaultState('1.0.0');
    state.auth.isAuthenticated = true;

    saveState(state);

    const loaded = loadState('1.0.0');
    expect(loaded.auth.isAuthenticated).toBe(true);
    expect(loaded.lastUpdated >= before).toBe(true);
  });

  it('throws when the state file path is not writable', () => {
    // Place a directory at the state file path so writeFileSync throws EISDIR
    mkdirSync(testStateFile, { recursive: true });

    expect(() => saveState(getDefaultState('1.0.0'))).toThrow('Failed to save state');
  });
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

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
 * SONARQUBE_CLI_DIR env var redirects state paths to a temporary directory.
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
import type { HookExtension, SkillExtension } from '../../../src/lib/state.js';
import { getDefaultState } from '../../../src/lib/state.js';
import {
  addInstalledHook,
  addOrUpdateConnection,
  clearAllConnections,
  findExtensionsByProject,
  generateConnectionId,
  markAgentConfigured,
  removeConnection,
  upsertAgentExtension,
} from '../../../src/lib/state-manager.js';

const testCliDir = join(tmpdir(), `sonar-cli-state-test-${Date.now()}`);
const testStateFile = join(testCliDir, 'state.json');

process.env.SONARQUBE_CLI_DIR = testCliDir;

afterAll(() => {
  delete process.env.SONARQUBE_CLI_DIR;
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

  describe('upsertAgentExtension: id preservation', () => {
    it('preserves original id when caller passes a different id on second upsert', () => {
      const state = getDefaultState('test');

      const firstEntry: HookExtension = {
        id: 'original-uuid-111',
        agentId: 'claude-code',
        projectRoot: '/project',
        global: false,
        updatedByCliVersion: '1.0.0',
        updatedAt: new Date().toISOString(),
        kind: 'hook',
        name: 'sonar-secrets',
        hookType: 'PreToolUse',
      };

      upsertAgentExtension(state, firstEntry);

      // Simulate what callers do: pass a new randomUUID() on every upsert
      const secondEntry: HookExtension = {
        ...firstEntry,
        id: 'replacement-uuid-222',
        updatedByCliVersion: '1.1.0',
      };

      upsertAgentExtension(state, secondEntry);

      expect(state.agentExtensions).toHaveLength(1);
      expect(state.agentExtensions[0].id).toBe('original-uuid-111');
    });
  });

  describe('upsertAgentExtension: non-hook (skill) extension', () => {
    it('matches non-hook extension by agentId + projectRoot + kind + name', () => {
      const state = getDefaultState('test');

      const ext: SkillExtension = {
        id: 'ext-1',
        agentId: 'claude-code',
        projectRoot: '/project',
        global: false,
        updatedByCliVersion: '1.0.0',
        updatedAt: new Date().toISOString(),
        kind: 'skill',
        name: 'sonarqube-cli-redeploy',
      };

      upsertAgentExtension(state, ext);
      expect(state.agentExtensions).toHaveLength(1);

      // Upserting the same non-hook extension should replace, not append
      const updated: SkillExtension = { ...ext, updatedAt: new Date().toISOString() };
      upsertAgentExtension(state, updated);
      expect(state.agentExtensions).toHaveLength(1);
      expect(state.agentExtensions[0].id).toBe('ext-1');
    });

    it('adds a second skill extension when name differs', () => {
      const state = getDefaultState('test');

      const ext1: SkillExtension = {
        id: 'ext-1',
        agentId: 'claude-code',
        projectRoot: '/project',
        global: false,
        updatedByCliVersion: '1.0.0',
        updatedAt: new Date().toISOString(),
        kind: 'skill',
        name: 'skill-a',
      };

      const ext2: SkillExtension = {
        id: 'ext-2',
        agentId: 'claude-code',
        projectRoot: '/project',
        global: false,
        updatedByCliVersion: '1.0.0',
        updatedAt: new Date().toISOString(),
        kind: 'skill',
        name: 'skill-b',
      };

      upsertAgentExtension(state, ext1);
      upsertAgentExtension(state, ext2);
      expect(state.agentExtensions).toHaveLength(2);
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

  it('initialises telemetry when absent in state file', () => {
    const raw = getDefaultState('0.1.0') as unknown as Record<string, unknown>;
    delete raw['telemetry'];
    mkdirSync(testCliDir, { recursive: true });
    writeFileSync(testStateFile, JSON.stringify(raw), 'utf-8');

    const state = loadState('0.1.0');

    expect(state.telemetry.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.telemetry.events).toEqual([]);
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
// findExtensionsByProject
// =============================================================================

describe('findExtensionsByProject', () => {
  it('returns extensions matching agentId and projectRoot', () => {
    const state = getDefaultState('1.0.0');
    const ext: HookExtension = {
      id: 'ext-1',
      agentId: 'claude-code',
      projectRoot: '/my/project',
      global: false,
      kind: 'hook',
      name: 'sonar-secrets',
      hookType: 'PreToolUse',
      updatedByCliVersion: '1.0.0',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    upsertAgentExtension(state, ext);

    const result = findExtensionsByProject(state, 'claude-code', '/my/project');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ext-1');
  });

  it('returns empty array when no extensions match', () => {
    const state = getDefaultState('1.0.0');

    const result = findExtensionsByProject(state, 'claude-code', '/my/project');

    expect(result).toHaveLength(0);
  });

  it('does not return extensions for a different agentId', () => {
    const state = getDefaultState('1.0.0');
    upsertAgentExtension(state, {
      id: 'ext-1',
      agentId: 'cursor',
      projectRoot: '/my/project',
      global: false,
      kind: 'hook',
      name: 'sonar-secrets',
      hookType: 'PreToolUse',
      updatedByCliVersion: '1.0.0',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = findExtensionsByProject(state, 'claude-code', '/my/project');

    expect(result).toHaveLength(0);
  });

  it('does not return extensions for a different projectRoot', () => {
    const state = getDefaultState('1.0.0');
    upsertAgentExtension(state, {
      id: 'ext-1',
      agentId: 'claude-code',
      projectRoot: '/other/project',
      global: false,
      kind: 'hook',
      name: 'sonar-secrets',
      hookType: 'PreToolUse',
      updatedByCliVersion: '1.0.0',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = findExtensionsByProject(state, 'claude-code', '/my/project');

    expect(result).toHaveLength(0);
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
// removeConnection / clearAllConnections
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

describe('clearAllConnections', () => {
  it('empties connections and resets auth flags', () => {
    const state = getDefaultState('1.0.0');
    addOrUpdateConnection(state, 'https://sonar.internal.com', 'on-premise');

    clearAllConnections(state);

    expect(state.auth.connections).toHaveLength(0);
    expect(state.auth.activeConnectionId).toBeUndefined();
    expect(state.auth.isAuthenticated).toBe(false);
  });
});

// =============================================================================
// markAgentConfigured / addInstalledHook — new-agent initialisation branch
// =============================================================================

describe('markAgentConfigured', () => {
  it('initialises missing agent entry before marking as configured', () => {
    const state = getDefaultState('1.0.0');

    markAgentConfigured(state, 'new-agent', '1.0.0');

    expect(state.agents['new-agent'].configured).toBe(true);
    expect(state.agents['new-agent'].configuredByCliVersion).toBe('1.0.0');
    expect(state.agents['new-agent'].hooks.installed).toEqual([]);
    expect(state.agents['new-agent'].skills.installed).toEqual([]);
  });
});

describe('addInstalledHook', () => {
  it('initialises missing agent entry before adding hook', () => {
    const state = getDefaultState('1.0.0');

    addInstalledHook(state, 'new-agent', 'sonar-secrets', 'PreToolUse');

    expect(state.agents['new-agent'].hooks.installed).toHaveLength(1);
    expect(state.agents['new-agent'].hooks.installed[0].name).toBe('sonar-secrets');
    expect(state.agents['new-agent'].hooks.installed[0].type).toBe('PreToolUse');
  });
});

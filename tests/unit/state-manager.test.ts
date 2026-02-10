/**
 * Tests for state manager
 */

import { describe, it, expect } from 'bun:test';
import {
  generateConnectionId,
  addOrUpdateConnection,
  getActiveConnection,
  findConnection,
  markAgentConfigured,
  addInstalledHook,
  addInstalledSkill,
} from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';

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

    it('should handle on-premise without orgKey', () => {
      const id = generateConnectionId('https://sonar.internal.company.com');
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
    });
  });

  describe('addOrUpdateConnection', () => {
    it('should add new cloud connection', () => {
      const state = getDefaultState('0.2.61');
      const connection = addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
        region: 'eu',
        keystoreKey: 'test-key',
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
      const connection = addOrUpdateConnection(state, 'https://sonar.internal.com', 'on-premise', {
        keystoreKey: 'test-key',
      });

      expect(connection.type).toBe('on-premise');
      expect(connection.orgKey).toBeUndefined();
      expect(connection.region).toBeUndefined();
    });

    it('should update existing connection', () => {
      const state = getDefaultState('0.2.61');
      const conn1 = addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
        region: 'eu',
        keystoreKey: 'key1',
      });

      const conn2 = addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
        region: 'us',
        keystoreKey: 'key2',
      });

      expect(conn1.id).toBe(conn2.id);
      expect(state.auth.connections).toHaveLength(1);
      expect(state.auth.connections[0].region).toBe('us');
    });
  });

  describe('getActiveConnection', () => {
    it('should return active connection', () => {
      const state = getDefaultState('0.2.61');
      const connection = addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
        region: 'eu',
        keystoreKey: 'test-key',
      });

      const active = getActiveConnection(state);
      expect(active).toEqual(connection);
    });

    it('should return undefined if no active connection', () => {
      const state = getDefaultState('0.2.61');
      expect(getActiveConnection(state)).toBeUndefined();
    });
  });

  describe('findConnection', () => {
    it('should find connection by serverUrl and orgKey', () => {
      const state = getDefaultState('0.2.61');
      addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
        orgKey: 'my-org',
        region: 'eu',
        keystoreKey: 'test-key',
      });

      const found = findConnection(state, 'https://sonarcloud.io', 'my-org');
      expect(found).toBeDefined();
      expect(found?.orgKey).toBe('my-org');
    });

    it('should return undefined for non-existent connection', () => {
      const state = getDefaultState('0.2.61');
      const found = findConnection(state, 'https://sonarcloud.io', 'non-existent');
      expect(found).toBeUndefined();
    });
  });

  describe('markAgentConfigured', () => {
    it('should mark agent as configured', () => {
      const state = getDefaultState('0.2.61');
      markAgentConfigured(state, 'claude-code', '0.2.61');

      expect(state.agents['claude-code'].configured).toBe(true);
      expect(state.agents['claude-code'].configuredByCliVersion).toBe('0.2.61');
      expect(state.agents['claude-code'].configuredAt).toBeDefined();
    });
  });

  describe('addInstalledHook', () => {
    it('should add hook to agent', () => {
      const state = getDefaultState('0.2.61');
      addInstalledHook(state, 'claude-code', 'my-hook', 'PostToolUse');

      expect(state.agents['claude-code'].hooks.installed).toHaveLength(1);
      expect(state.agents['claude-code'].hooks.installed[0].name).toBe('my-hook');
      expect(state.agents['claude-code'].hooks.installed[0].type).toBe('PostToolUse');
    });

    it('should not create duplicates', () => {
      const state = getDefaultState('0.2.61');
      addInstalledHook(state, 'claude-code', 'my-hook', 'PostToolUse');
      addInstalledHook(state, 'claude-code', 'my-hook', 'PostToolUse');

      expect(state.agents['claude-code'].hooks.installed).toHaveLength(1);
    });
  });

  describe('addInstalledSkill', () => {
    it('should add skill to agent', () => {
      const state = getDefaultState('0.2.61');
      addInstalledSkill(state, 'claude-code', 'my-skill');

      expect(state.agents['claude-code'].skills.installed).toHaveLength(1);
      expect(state.agents['claude-code'].skills.installed[0].name).toBe('my-skill');
    });

    it('should not create duplicates', () => {
      const state = getDefaultState('0.2.61');
      addInstalledSkill(state, 'claude-code', 'my-skill');
      addInstalledSkill(state, 'claude-code', 'my-skill');

      expect(state.agents['claude-code'].skills.installed).toHaveLength(1);
    });
  });
});

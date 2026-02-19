/**
 * Tests for state management
 */

import { describe, it, expect } from 'bun:test';
import { getDefaultState } from '../../src/lib/state.js';

describe('State Management', () => {
  describe('getDefaultState', () => {
    it('should create default state with correct structure', () => {
      const state = getDefaultState('0.2.61');

      expect(state.version).toBe('1.0');
      expect(state.auth.isAuthenticated).toBe(false);
      expect(state.auth.connections).toEqual([]);
      expect(state.auth.activeConnectionId).toBeUndefined();
      expect(state.agents['claude-code']).toBeDefined();
      expect(state.agents['claude-code'].configured).toBe(false);
      expect(state.config.cliVersion).toBe('0.2.61');
    });

    it('should have correct agent structure', () => {
      const state = getDefaultState('0.2.61');
      const agent = state.agents['claude-code'];

      expect(agent.hooks.installed).toEqual([]);
      expect(agent.skills.installed).toEqual([]);
      expect(agent.configuredAt).toBeUndefined();
      expect(agent.configuredByCliVersion).toBeUndefined();
    });

    it('should have valid ISO timestamp', () => {
      const state = getDefaultState('0.2.61');
      expect(() => new Date(state.lastUpdated)).not.toThrow();
    });
  });
});

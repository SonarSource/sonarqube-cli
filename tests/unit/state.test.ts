/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

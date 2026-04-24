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
 * Tests for state management
 */

import { describe, expect, it } from 'bun:test';

import { getDefaultState } from '../../../src/lib/state.js';

describe('State Management', () => {
  describe('getDefaultState', () => {
    it('returns a correctly structured default state', () => {
      const state = getDefaultState('0.2.61');

      expect(state.version).toBe('1.0');
      expect(state.auth.isAuthenticated).toBe(false);
      expect(state.auth.connections).toEqual([]);
      expect(state.auth.activeConnectionId).toBeUndefined();
      expect(state.config.cliVersion).toBe('0.2.61');
      expect(state.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const agent = state.agents['claude-code'];
      expect(agent.configured).toBe(false);
      expect(agent.hooks.installed).toEqual([]);
      expect(agent.skills.installed).toEqual([]);
      expect(agent.configuredAt).toBeUndefined();
      expect(agent.configuredByCliVersion).toBeUndefined();
    });
  });
});

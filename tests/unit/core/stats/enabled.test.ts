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

import { describe, expect, it, spyOn } from 'bun:test';

import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import {
  describeStatsStatus,
  isStatsCollectionEnabled,
  isStatsEnabled,
} from '@/core/stats/enabled.ts';

describe('isStatsEnabled', () => {
  it('returns true when absent from state', () => {
    const state = getDefaultState('1.0.0');

    expect(state.stats).toBeUndefined();
    expect(isStatsEnabled(state)).toBe(true);
  });

  it('returns true when enabled in state', () => {
    const state = getDefaultState('1.0.0');
    state.stats = { enabled: true };

    expect(isStatsEnabled(state)).toBe(true);
  });

  it('returns false when disabled in state', () => {
    const state = getDefaultState('1.0.0');
    state.stats = { enabled: false };

    expect(isStatsEnabled(state)).toBe(false);
  });
});

describe('isStatsCollectionEnabled', () => {
  it('returns true when state loads with no explicit stats preference', () => {
    const loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(
      getDefaultState('1.0.0'),
    );

    expect(isStatsCollectionEnabled()).toBe(true);

    loadStateSpy.mockRestore();
  });

  it('returns false when state loads with stats explicitly disabled', () => {
    const state = getDefaultState('1.0.0');
    state.stats = { enabled: false };
    const loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(state);

    expect(isStatsCollectionEnabled()).toBe(false);

    loadStateSpy.mockRestore();
  });

  it('returns false (fails closed) when state cannot be loaded', () => {
    const loadStateSpy = spyOn(stateRepository, 'loadState').mockImplementation(() => {
      throw new Error('corrupted state');
    });

    expect(isStatsCollectionEnabled()).toBe(false);

    loadStateSpy.mockRestore();
  });
});

describe('describeStatsStatus', () => {
  it('reports enabled by default', () => {
    expect(describeStatsStatus(getDefaultState('1.0.0'))).toBe(
      'Stats collection is currently enabled.',
    );
  });

  it('reports disabled when explicitly turned off', () => {
    const state = getDefaultState('1.0.0');
    state.stats = { enabled: false };

    expect(describeStatsStatus(state)).toBe('Stats collection is currently disabled.');
  });
});

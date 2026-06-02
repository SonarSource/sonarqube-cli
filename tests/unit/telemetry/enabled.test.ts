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

import { afterEach, describe, expect, it } from 'bun:test';

import { ENV_DO_NOT_TRACK } from '../../../src/lib/config-constants.js';
import { getDefaultState } from '../../../src/lib/state.js';
import {
  describeTelemetryStatus,
  isDoNotTrackRequested,
  isTelemetryEnabled,
} from '../../../src/telemetry/enabled.js';

afterEach(() => {
  delete process.env[ENV_DO_NOT_TRACK];
});

describe('isDoNotTrackRequested', () => {
  it('returns true when set to 1', () => {
    process.env[ENV_DO_NOT_TRACK] = '1';
    expect(isDoNotTrackRequested()).toBe(true);
  });

  it('returns true when set to 1 with surrounding whitespace', () => {
    process.env[ENV_DO_NOT_TRACK] = ' 1 ';
    expect(isDoNotTrackRequested()).toBe(true);
  });

  it.each(['0', 'yes', 'true', ''])('returns false for %s', (value) => {
    process.env[ENV_DO_NOT_TRACK] = value;
    expect(isDoNotTrackRequested()).toBe(false);
  });

  it('returns false when unset', () => {
    expect(isDoNotTrackRequested()).toBe(false);
  });
});

describe('isTelemetryEnabled', () => {
  it('returns true when enabled in state and DO_NOT_TRACK is unset', () => {
    const state = getDefaultState('1.0.0');
    state.telemetry.enabled = true;

    expect(isTelemetryEnabled(state)).toBe(true);
  });

  it('returns false when disabled in state', () => {
    const state = getDefaultState('1.0.0');
    state.telemetry.enabled = false;

    expect(isTelemetryEnabled(state)).toBe(false);
  });

  it('returns false when DO_NOT_TRACK is set even if enabled in state', () => {
    const state = getDefaultState('1.0.0');
    state.telemetry.enabled = true;
    process.env[ENV_DO_NOT_TRACK] = '1';

    expect(isTelemetryEnabled(state)).toBe(false);
  });
});

describe('describeTelemetryStatus', () => {
  it('mentions DO_NOT_TRACK when it disables telemetry', () => {
    const state = getDefaultState('1.0.0');
    state.telemetry.enabled = true;
    process.env[ENV_DO_NOT_TRACK] = '1';

    expect(describeTelemetryStatus(state)).toBe(
      'Telemetry is currently disabled (DO_NOT_TRACK is set).',
    );
  });

  it('reports persisted state when DO_NOT_TRACK is unset', () => {
    const state = getDefaultState('1.0.0');
    state.telemetry.enabled = false;

    expect(describeTelemetryStatus(state)).toBe('Telemetry is currently disabled.');
  });
});

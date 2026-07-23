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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  describeTelemetryStatus,
  isDoNotTrackRequested,
  isTelemetryEnabled,
} from '@/core/telemetry/enabled.ts';
import { ENV_DO_NOT_TRACK } from '@/lib/config-constants.ts';
import { getDefaultState } from '@/lib/state.ts';

import { restoreEnv } from '../../../_common/isolated-cli-env.ts';

// Each test runs from an unset baseline; restore the preload's DO_NOT_TRACK afterwards
// so we don't leak a cleared value that would re-enable telemetry for later tests.
const PRELOAD_DO_NOT_TRACK = process.env[ENV_DO_NOT_TRACK];

beforeEach(() => {
  delete process.env[ENV_DO_NOT_TRACK];
});

afterEach(() => {
  restoreEnv(ENV_DO_NOT_TRACK, PRELOAD_DO_NOT_TRACK);
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

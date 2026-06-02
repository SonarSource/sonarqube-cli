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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { configureTelemetry } from '../../../../../src/cli/commands/config/telemetry';
import { ENV_DO_NOT_TRACK } from '../../../../../src/lib/config-constants.js';
import * as stateRepository from '../../../../../src/lib/repository/state-repository.js';
import { getDefaultState } from '../../../../../src/lib/state.js';
import { clearMockUiCalls, findMockUiCall, getMockUiCalls, setMockUi } from '../../../../../src/ui';

let loadStateSpy: ReturnType<typeof spyOn>;
let saveStateSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  setMockUi(true);
  loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(getDefaultState('1.0.0'));
  saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => undefined);
});

afterEach(() => {
  setMockUi(false);
  loadStateSpy.mockRestore();
  saveStateSpy.mockRestore();
  delete process.env[ENV_DO_NOT_TRACK];
});

describe('configureTelemetry', () => {
  it('reports effective disabled state when --enabled is run with DO_NOT_TRACK set', async () => {
    process.env[ENV_DO_NOT_TRACK] = '1';

    await configureTelemetry({ enabled: true });

    expect(saveStateSpy).toHaveBeenCalled();
    expect(saveStateSpy.mock.calls[0][0].telemetry.enabled).toBe(true);
    expect(findMockUiCall('success', 'preference saved as enabled')).toBeDefined();
    expect(findMockUiCall('info', 'DO_NOT_TRACK')).toBeDefined();
    expect(findMockUiCall('success', 'Telemetry enabled.')).toBeUndefined();
  });

  it('reports enabled when --enabled is run without DO_NOT_TRACK', async () => {
    await configureTelemetry({ enabled: true });

    expect(findMockUiCall('success', 'Telemetry enabled.')).toBeDefined();
    expect(getMockUiCalls().some((call) => call.method === 'info')).toBe(false);
  });

  it('reports DO_NOT_TRACK override when showing status', async () => {
    process.env[ENV_DO_NOT_TRACK] = '1';
    clearMockUiCalls();

    await configureTelemetry({});

    expect(findMockUiCall('info', 'DO_NOT_TRACK')).toBeDefined();
  });
});

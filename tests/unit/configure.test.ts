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

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { configureTelemetry } from '../../src/commands/config';
import * as stateManager from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui';
import { InvalidOptionError } from '../../src/commands/common/error.js';

describe('configureTelemetry', () => {
  let loadStateSpy: any;
  let saveStateSpy: any;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  // -------------------------------------------------------------------------
  // Enabling telemetry
  // -------------------------------------------------------------------------

  it('sets telemetry.enabled to true when --enabled is passed', async () => {
    await configureTelemetry({ enabled: true });

    const savedState = saveStateSpy.mock.calls[0][0];
    expect(savedState.telemetry.enabled).toBe(true);
  });

  it('saves state when --enabled is passed', async () => {
    await configureTelemetry({ enabled: true });
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
  });

  it('prints a success message when telemetry is enabled', async () => {
    await configureTelemetry({ enabled: true });

    const messages = getMockUiCalls()
      .filter((c) => c.method === 'success')
      .map((c) => String(c.args[0]));
    expect(messages.some((m) => m.includes('enabled'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Disabling telemetry
  // -------------------------------------------------------------------------

  it('sets telemetry.enabled to false when --disabled is passed', async () => {
    await configureTelemetry({ disabled: true });

    const savedState = saveStateSpy.mock.calls[0][0];
    expect(savedState.telemetry.enabled).toBe(false);
  });

  it('saves state when --disabled is passed', async () => {
    await configureTelemetry({ disabled: true });
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
  });

  it('prints a success message when telemetry is disabled', async () => {
    await configureTelemetry({ disabled: true });

    const messages = getMockUiCalls()
      .filter((c) => c.method === 'success')
      .map((c) => String(c.args[0]));
    expect(messages.some((m) => m.includes('disabled'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // No flag: display current state
  // -------------------------------------------------------------------------

  it('displays current telemetry state when no flag is passed and telemetry is enabled', async () => {
    loadStateSpy.mockReturnValue({
      ...getDefaultState('test'),
      telemetry: { enabled: true, events: [], installationId: null },
    });
    await configureTelemetry({});
    const messages = getMockUiCalls()
      .filter((c) => c.method === 'info')
      .map((c) => String(c.args[0]));
    expect(messages.some((m) => m.includes('enabled'))).toBe(true);
  });

  it('displays current telemetry state when no flag is passed and telemetry is disabled', async () => {
    loadStateSpy.mockReturnValue({
      ...getDefaultState('test'),
      telemetry: { enabled: false, events: [], installationId: null },
    });
    await configureTelemetry({});
    const messages = getMockUiCalls()
      .filter((c) => c.method === 'info')
      .map((c) => String(c.args[0]));
    expect(messages.some((m) => m.includes('disabled'))).toBe(true);
  });

  it('does not save state when no flag is passed', async () => {
    await configureTelemetry({});
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Validation: both flags
  // -------------------------------------------------------------------------

  it('throws InvalidOptionError when both --enabled and --disabled are passed', () => {
    expect(configureTelemetry({ enabled: true, disabled: true })).rejects.toThrow(
      InvalidOptionError,
    );
  });

  it('includes a helpful message when both flags are passed', () => {
    expect(configureTelemetry({ enabled: true, disabled: true })).rejects.toThrow(
      'Cannot use both --enabled and --disabled',
    );
  });
});

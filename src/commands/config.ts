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
// Configure CLI settings

import { loadState, saveState } from '../lib/state-manager.js';
import { info, success } from '../ui';
import { InvalidOptionError } from './common/error.js';

export interface ConfigureTelemetryOptions {
  enabled?: boolean;
  disabled?: boolean;
}

export function configureTelemetry(options: ConfigureTelemetryOptions): Promise<void> {
  if (options.enabled && options.disabled) {
    return Promise.reject(new InvalidOptionError('Cannot use both --enabled and --disabled'));
  }
  if (!options.enabled && !options.disabled) {
    const state = loadState();
    info(`Telemetry is currently ${state.telemetry.enabled ? 'enabled' : 'disabled'}.`);
    return Promise.resolve();
  }
  const state = loadState();
  state.telemetry.enabled = options.enabled ?? false;
  saveState(state);
  success(`Telemetry ${options.enabled ? 'enabled' : 'disabled'}.`);
  return Promise.resolve();
}

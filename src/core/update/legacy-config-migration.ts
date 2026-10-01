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

import { getConfigFileValue, setConfigFileValue } from '../config/config-file.ts';
import type { ConfigKey } from '../config/config-schema.ts';
import { loadState, saveState } from '../state/state-repository.ts';

/** Moves the legacy telemetry and stats opt-outs from `state.json` to the config store. */
export function migrateLegacyStateConfig(): void {
  const state = loadState();
  const telemetryEnabled = state.telemetry.enabled;
  const statsEnabled = state.stats?.enabled;
  if (telemetryEnabled === undefined && statsEnabled === undefined) {
    return;
  }

  carryOptOut('telemetry.enabled', telemetryEnabled);
  carryOptOut('stats.enabled', statsEnabled);

  delete state.telemetry.enabled;
  delete state.stats;
  saveState(state);
}

function carryOptOut(key: ConfigKey, enabled: boolean | undefined): void {
  if (enabled === false && getConfigFileValue(key) === undefined) {
    setConfigFileValue(key, 'false');
  }
}

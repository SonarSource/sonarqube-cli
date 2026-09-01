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
// Configure CLI settings

import { InvalidOptionError } from '@/core/command-error.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { loadState, saveState } from '@/core/state/state-repository.ts';
import { describeTelemetryStatus, isDoNotTrackRequested } from '@/core/telemetry/enabled.ts';
import { TerminalConsole } from '@/core/ui/terminal-console.ts';

export interface ConfigureTelemetryOptions {
  enabled?: boolean;
  disabled?: boolean;
}

export function configureTelemetry(
  options: ConfigureTelemetryOptions,
  ctx: CommandInvocationContext = new CommandInvocationContext(new TerminalConsole()),
): Promise<void> {
  const { console } = ctx;
  if (options.enabled && options.disabled) {
    return Promise.reject(new InvalidOptionError('Cannot use both --enabled and --disabled'));
  }
  if (!options.enabled && !options.disabled) {
    const state = loadState();
    console.info(describeTelemetryStatus(state));
    return Promise.resolve();
  }
  const state = loadState();
  const persistedEnabled = options.enabled ?? false;
  state.telemetry.enabled = persistedEnabled;
  saveState(state);
  if (persistedEnabled && isDoNotTrackRequested()) {
    console.success('Telemetry preference saved as enabled.');
    console.info('Telemetry is currently disabled (DO_NOT_TRACK is set).');
  } else {
    console.success(`Telemetry ${persistedEnabled ? 'enabled' : 'disabled'}.`);
  }
  return Promise.resolve();
}

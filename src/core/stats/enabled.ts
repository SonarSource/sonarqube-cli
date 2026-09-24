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

import type { CliState } from '@/core/state/state.ts';
import { tryLoadState } from '@/core/state/state-manager.ts';

/** Defaults to enabled: an absent `stats` field means the user hasn't opted out. */
export function isStatsEnabled(state: CliState): boolean {
  return state.stats?.enabled ?? true;
}

/** Whether local stats collection should run for this invocation. An unreadable state
 *  proves nothing about consent either way, so it fails closed (disabled). */
export function isStatsCollectionEnabled(): boolean {
  const state = tryLoadState();
  return state !== null && isStatsEnabled(state);
}

export function describeStatsStatus(state: CliState): string {
  return `Stats collection is currently ${isStatsEnabled(state) ? 'enabled' : 'disabled'}.`;
}

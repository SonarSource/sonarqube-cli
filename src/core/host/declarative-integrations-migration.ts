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

// Declarative integration replay, consumed by the post-update mechanism that
// runs automatically after CLI upgrades. The actual reconciliation logic
// lives in core/framework/features — this is just the load/save wrapper.

import {
  type IntegrationRegistry,
  reconcileInstalledIntegrations,
} from '@/core/framework/features';

import { loadState, saveState } from '../state/state-repository.ts';

export async function migrateDeclarativeIntegrations(registry: IntegrationRegistry): Promise<void> {
  const state = loadState();
  if (await reconcileInstalledIntegrations(state, registry)) {
    saveState(state);
  }
}

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

// One-time historical backfill of `state.knownServerProjectMappings`, consumed by the
// post-update mechanism that runs automatically after CLI upgrades. The actual attrs-parsing
// derivation (buildKnownServerProjectMappings) lives in core/known-server-project-mappings.ts,
// shared with discoverProject()'s live fallback. Must run before `migrateDeclarativeIntegrations`
// (see post-update.ts): once integrations move to global scope they stop carrying per-folder
// `projectKey`/`repoRoot` attrs, so this is the last point where that data is still readable
// from the pre-reconciliation feature set.

import {
  buildKnownServerProjectMappings,
  mergeKnownServerProjectMappings,
} from '@/core/known-server-project-mappings.ts';
import { loadState, saveState } from '@/core/state/state-repository.ts';

import logger from '../observability/logger.ts';

export function migrateKnownServerKeyMappingsForProjectLevelFeatures(): void {
  try {
    const state = loadState();
    const discovered = buildKnownServerProjectMappings(state);
    if (discovered.length === 0) {
      return;
    }

    state.knownServerProjectMappings = mergeKnownServerProjectMappings(
      state.knownServerProjectMappings ?? [],
      discovered,
    );
    saveState(state);
  } catch (error) {
    logger.warn(`Known-server-project-mappings migration failed: ${(error as Error).message}`);
  }
}

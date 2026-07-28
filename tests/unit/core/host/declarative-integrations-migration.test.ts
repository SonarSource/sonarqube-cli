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

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';

import { IntegrationRegistry } from '@/core/framework/features';
import { migrateDeclarativeIntegrations } from '@/core/host/declarative-integrations-migration.ts';
import type { CliState } from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';

function makeState(): CliState {
  return getDefaultState('1.0.0');
}

describe('migrateDeclarativeIntegrations', () => {
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let saveStateSpy: Mock<typeof stateRepository.saveState>;

  beforeEach(() => {
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeState());
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => {});
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
  });

  it('loads state, reconciles the registry against it, and saves when changed', async () => {
    const state = makeState();
    loadStateSpy.mockReturnValue(state);

    const registry = new IntegrationRegistry();

    await migrateDeclarativeIntegrations(registry);

    expect(loadStateSpy).toHaveBeenCalledTimes(1);
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  it('saves state when reconciliation reports a change', async () => {
    const now = '2026-01-01T00:00:00.000Z';
    const state = makeState();
    state.integrations.installed.push({
      id: 'integration-id',
      integrationId: 'test-integration',
      installedByCliVersion: '0.9.0',
      installedAt: now,
      updatedByCliVersion: '0.9.0',
      updatedAt: now,
      features: [
        {
          featureId: 'removed-feature',
          scope: 'project',
          targetRoot: '/does-not-matter',
          installedByCliVersion: '0.9.0',
          installedAt: now,
          updatedByCliVersion: '0.9.0',
          updatedAt: now,
          dependencies: [],
          resources: [],
          operations: [],
        },
      ],
    });
    loadStateSpy.mockReturnValue(state);

    // Registry has no matching feature declaration, so the unknown
    // 'removed-feature' entry gets pruned — that alone should trigger a save.
    const registry = new IntegrationRegistry();
    registry.register({
      id: 'test-integration',
      displayName: 'Test integration',
      features: [],
    });

    await migrateDeclarativeIntegrations(registry);

    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    expect(saveStateSpy.mock.calls[0][0].integrations.installed[0].features).toHaveLength(0);
  });
});

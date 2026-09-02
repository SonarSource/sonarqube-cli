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

import type {
  CliState,
  InstalledIntegration,
  InstalledIntegrationFeature,
  KnownServerProjectMapping,
} from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import { migrateKnownServerKeyMappingsForProjectLevelFeatures } from '@/core/update/known-project-mappings-migration.ts';

function makeState(): CliState {
  return getDefaultState('1.0.0');
}

function makeFeature(
  overrides: Partial<InstalledIntegrationFeature> = {},
): InstalledIntegrationFeature {
  return {
    featureId: 'some-feature',
    scope: 'project',
    targetRoot: '/repo',
    installedByCliVersion: '1.0.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedByCliVersion: '1.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
    dependencies: [],
    resources: [],
    operations: [],
    ...overrides,
  };
}

function makeIntegration(
  features: InstalledIntegrationFeature[],
  overrides: Partial<InstalledIntegration> = {},
): InstalledIntegration {
  return {
    id: 'integration-1',
    integrationId: 'claude-code',
    installedByCliVersion: '1.0.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedByCliVersion: '1.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
    features,
    ...overrides,
  };
}

function makeMapping(
  overrides: Partial<KnownServerProjectMapping> = {},
): KnownServerProjectMapping {
  return {
    targetRoot: '/repo',
    projectKey: 'my-project',
    serverUrl: 'https://sonarqube.example.com',
    ...overrides,
  };
}

describe('migrateKnownServerProjectMappings', () => {
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

  it('does nothing when there is nothing to discover', () => {
    migrateKnownServerKeyMappingsForProjectLevelFeatures();

    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  it('merges discovered mappings into the existing table and saves', () => {
    const state = makeState();
    state.knownServerProjectMappings = [
      makeMapping({ targetRoot: '/kept', projectKey: 'kept-project' }),
    ];
    state.integrations.installed = [
      makeIntegration([
        makeFeature({
          targetRoot: '/repo',
          attrs: {
            projectKey: 'discovered-project',
            serverUrl: 'https://sonarqube.example.com',
          },
        }),
      ]),
    ];
    loadStateSpy.mockReturnValue(state);

    migrateKnownServerKeyMappingsForProjectLevelFeatures();

    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    const savedState = saveStateSpy.mock.calls[0][0];
    const saved = (savedState.knownServerProjectMappings ?? [])
      .slice()
      .sort((a, b) => a.targetRoot.localeCompare(b.targetRoot));
    expect(saved).toEqual([
      {
        targetRoot: '/kept',
        projectKey: 'kept-project',
        serverUrl: 'https://sonarqube.example.com',
      },
      {
        targetRoot: '/repo',
        projectKey: 'discovered-project',
        serverUrl: 'https://sonarqube.example.com',
        repoRoot: undefined,
        orgKey: undefined,
      },
    ]);
  });

  it('swallows a failure instead of throwing', () => {
    loadStateSpy.mockImplementation(() => {
      throw new Error('disk read failed');
    });

    expect(() => migrateKnownServerKeyMappingsForProjectLevelFeatures()).not.toThrow();
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  it('keeps two worktrees of the same repo, sharing a repoRoot attr, as distinct mappings', () => {
    const state = makeState();
    state.integrations.installed = [
      makeIntegration(
        [
          makeFeature({
            targetRoot: '/main',
            attrs: {
              projectKey: 'main-project',
              serverUrl: 'https://sonarqube.example.com',
              repoRoot: '/main',
            },
          }),
        ],
        { integrationId: 'claude-code-main' },
      ),
      makeIntegration(
        [
          makeFeature({
            targetRoot: '/linked-worktree',
            attrs: {
              projectKey: 'worktree-project',
              serverUrl: 'https://sonarqube.example.com',
              repoRoot: '/main',
            },
          }),
        ],
        { integrationId: 'claude-code-worktree' },
      ),
    ];
    loadStateSpy.mockReturnValue(state);

    migrateKnownServerKeyMappingsForProjectLevelFeatures();

    const savedState = saveStateSpy.mock.calls[0][0];
    const projectKeys = (savedState.knownServerProjectMappings ?? [])
      .map((m) => m.projectKey)
      .sort();
    expect(projectKeys).toEqual(['main-project', 'worktree-project']);
  });
});

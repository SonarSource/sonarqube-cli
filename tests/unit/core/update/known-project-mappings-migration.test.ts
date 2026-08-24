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

import * as gitWorktree from '@/core/host/git/worktree.ts';
import type {
  AuthConnection,
  CliState,
  InstalledIntegration,
  InstalledIntegrationFeature,
  KnownServerProjectMapping,
} from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import {
  buildKnownServerProjectMappings,
  mergeKnownServerProjectMappings,
  migrateKnownServerKeyMappingsForProjectLevelFeatures,
} from '@/core/update/known-project-mappings-migration.ts';

function makeState(): CliState {
  return getDefaultState('1.0.0');
}

/** Sets an active connection on state, for tests exercising the attrs-missing fallback. */
function withActiveConnection(state: CliState, overrides: Partial<AuthConnection> = {}): CliState {
  const connection: AuthConnection = {
    id: 'conn-1',
    type: 'cloud',
    serverUrl: 'https://active-connection.example.com',
    authenticatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  state.auth.connections = [connection];
  state.auth.activeConnectionId = connection.id;
  return state;
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
    folder: '/repo',
    projectKey: 'my-project',
    serverUrl: 'https://sonarqube.example.com',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Builds mappings from a state with a single integration holding a single feature. */
function buildMappingsForFeature(
  featureOverrides: Partial<InstalledIntegrationFeature>,
  state: CliState = makeState(),
): Promise<KnownServerProjectMapping[]> {
  state.integrations.installed = [makeIntegration([makeFeature(featureOverrides)])];
  return buildKnownServerProjectMappings(state);
}

describe('buildKnownServerProjectMappings', () => {
  let resolveRecordedRepoRootSpy: Mock<(typeof gitWorktree)['resolveRecordedRepoRoot']>;

  beforeEach(() => {
    // Identity mock: real worktree normalization is exercised separately below.
    resolveRecordedRepoRootSpy = spyOn(gitWorktree, 'resolveRecordedRepoRoot').mockImplementation(
      (projectRoot: string) => Promise.resolve(projectRoot),
    );
  });

  afterEach(() => {
    resolveRecordedRepoRootSpy.mockRestore();
  });

  it('skips global-scope features', async () => {
    const mappings = await buildMappingsForFeature({
      scope: 'global',
      attrs: { projectKey: 'proj', serverUrl: 'https://sonarqube.example.com' },
      targetRoot: '/home',
    });

    expect(mappings).toEqual([]);
  });

  it('skips features without an explicit projectKey attr', async () => {
    const state = makeState();
    state.integrations.installed = [
      makeIntegration([makeFeature({ attrs: undefined }), makeFeature({ attrs: {} })]),
    ];

    const mappings = await buildKnownServerProjectMappings(state);

    expect(mappings).toEqual([]);
  });

  it('skips a feature with a projectKey but no resolvable serverUrl', async () => {
    // makeState() has no active connection, and this feature has no serverUrl attr.
    const mappings = await buildMappingsForFeature({ attrs: { projectKey: 'my-project' } });

    expect(mappings).toEqual([]);
  });

  it('records a mapping for a project-scoped feature with explicit projectKey/serverUrl attrs', async () => {
    const mappings = await buildMappingsForFeature({
      targetRoot: '/repo',
      attrs: {
        projectKey: 'my-project',
        serverUrl: 'https://sonarqube.example.com',
        orgKey: 'my-org',
      },
    });

    expect(mappings).toEqual([
      makeMapping({ serverUrl: 'https://sonarqube.example.com', orgKey: 'my-org' }),
    ]);
  });

  it('falls back to the active connection for serverUrl/orgKey when the feature attrs lack them (e.g. git integrate)', async () => {
    const state = withActiveConnection(makeState(), {
      serverUrl: 'https://active-connection.example.com',
      orgKey: 'active-org',
    });

    const mappings = await buildMappingsForFeature({ attrs: { projectKey: 'my-project' } }, state);

    expect(mappings).toEqual([
      makeMapping({ serverUrl: 'https://active-connection.example.com', orgKey: 'active-org' }),
    ]);
  });

  it('prefers the feature-recorded serverUrl/orgKey over the active connection', async () => {
    const state = withActiveConnection(makeState(), {
      serverUrl: 'https://active-connection.example.com',
      orgKey: 'active-org',
    });

    const mappings = await buildMappingsForFeature(
      {
        attrs: {
          projectKey: 'my-project',
          serverUrl: 'https://recorded.example.com',
          orgKey: 'recorded-org',
        },
      },
      state,
    );

    expect(mappings).toEqual([
      makeMapping({ serverUrl: 'https://recorded.example.com', orgKey: 'recorded-org' }),
    ]);
  });

  it('resolves the folder from a recorded repoRoot attr through resolveRecordedRepoRoot, not the raw attr', async () => {
    resolveRecordedRepoRootSpy.mockImplementation((projectRoot: string) =>
      Promise.resolve(projectRoot === '/worktree/repo' ? '/main/repo' : projectRoot),
    );

    const mappings = await buildMappingsForFeature({
      targetRoot: '/physical/install/dir',
      attrs: {
        projectKey: 'my-project',
        serverUrl: 'https://sonarqube.example.com',
        repoRoot: '/worktree/repo',
      },
    });

    expect(resolveRecordedRepoRootSpy).toHaveBeenCalledWith('/worktree/repo');
    expect(mappings).toEqual([makeMapping({ folder: '/main/repo' })]);
  });

  it('falls back to targetRoot, normalized to the main worktree, when no repoRoot attr is recorded', async () => {
    resolveRecordedRepoRootSpy.mockImplementation((projectRoot: string) =>
      Promise.resolve(projectRoot === '/linked/worktree' ? '/main/repo' : projectRoot),
    );

    const mappings = await buildMappingsForFeature({
      targetRoot: '/linked/worktree',
      attrs: { projectKey: 'my-project', serverUrl: 'https://sonarqube.example.com' },
    });

    expect(resolveRecordedRepoRootSpy).toHaveBeenCalledWith('/linked/worktree');
    expect(mappings).toEqual([makeMapping({ folder: '/main/repo' })]);
  });

  it('keeps the most recently updated feature when two features resolve to the same folder', async () => {
    const state = makeState();
    state.integrations.installed = [
      makeIntegration(
        [
          makeFeature({
            attrs: { projectKey: 'old-project', serverUrl: 'https://sonarqube.example.com' },
            updatedAt: '2026-01-01T00:00:00.000Z',
          }),
        ],
        { integrationId: 'git' },
      ),
      makeIntegration(
        [
          makeFeature({
            attrs: { projectKey: 'new-project', serverUrl: 'https://sonarqube.example.com' },
            updatedAt: '2026-02-01T00:00:00.000Z',
          }),
        ],
        { integrationId: 'claude-code' },
      ),
    ];

    const mappings = await buildKnownServerProjectMappings(state);

    expect(mappings).toEqual([
      makeMapping({ projectKey: 'new-project', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
  });
});

describe('mergeKnownServerProjectMappings', () => {
  it('adds newly discovered folders to an empty table', () => {
    const merged = mergeKnownServerProjectMappings([], [makeMapping()]);

    expect(merged).toEqual([makeMapping()]);
  });

  it('preserves an existing entry that a fresh discovery pass no longer reproduces', () => {
    const existing = [makeMapping({ folder: '/now-global-only' })];

    const merged = mergeKnownServerProjectMappings(existing, []);

    expect(merged).toEqual(existing);
  });

  it('lets a newer discovered entry supersede a stale existing one for the same folder', () => {
    const existing = [
      makeMapping({ projectKey: 'old-project', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const discovered = [
      makeMapping({ projectKey: 'new-project', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ];

    const merged = mergeKnownServerProjectMappings(existing, discovered);

    expect(merged).toEqual(discovered);
  });

  it('keeps the existing entry when the discovered one is not newer', () => {
    const existing = [
      makeMapping({ projectKey: 'current-project', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ];
    const discovered = [
      makeMapping({ projectKey: 'stale-project', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ];

    const merged = mergeKnownServerProjectMappings(existing, discovered);

    expect(merged).toEqual(existing);
  });
});

describe('migrateKnownServerProjectMappings', () => {
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let saveStateSpy: Mock<typeof stateRepository.saveState>;
  let resolveRecordedRepoRootSpy: Mock<(typeof gitWorktree)['resolveRecordedRepoRoot']>;

  beforeEach(() => {
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeState());
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => {});
    resolveRecordedRepoRootSpy = spyOn(gitWorktree, 'resolveRecordedRepoRoot').mockImplementation(
      (projectRoot: string) => Promise.resolve(projectRoot),
    );
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    resolveRecordedRepoRootSpy.mockRestore();
  });

  it('does nothing when there is nothing to discover', async () => {
    await migrateKnownServerKeyMappingsForProjectLevelFeatures();

    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  it('merges discovered mappings into the existing table and saves', async () => {
    const state = makeState();
    state.knownServerProjectMappings = [
      makeMapping({ folder: '/kept', projectKey: 'kept-project' }),
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

    await migrateKnownServerKeyMappingsForProjectLevelFeatures();

    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    const savedState = saveStateSpy.mock.calls[0][0];
    const saved = (savedState.knownServerProjectMappings ?? [])
      .slice()
      .sort((a, b) => a.folder.localeCompare(b.folder));
    expect(saved).toEqual([
      {
        folder: '/kept',
        projectKey: 'kept-project',
        serverUrl: 'https://sonarqube.example.com',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        folder: '/repo',
        projectKey: 'discovered-project',
        serverUrl: 'https://sonarqube.example.com',
        orgKey: undefined,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });
});

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

import { describe, expect, it } from 'bun:test';

import {
  buildKnownServerProjectMappings,
  mergeKnownServerProjectMappings,
} from '@/core/known-server-project-mappings.ts';
import type {
  AuthConnection,
  CliState,
  InstalledIntegration,
  InstalledIntegrationFeature,
  KnownServerProjectMapping,
} from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';

function makeState(): CliState {
  return getDefaultState('1.0.0');
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

describe('mergeKnownServerProjectMappings', () => {
  it('adds newly discovered targetRoots to an empty table', () => {
    const merged = mergeKnownServerProjectMappings([], [makeMapping()]);

    expect(merged).toEqual([makeMapping()]);
  });

  it('preserves an existing entry that a fresh discovery pass no longer reproduces', () => {
    const existing = [makeMapping({ targetRoot: '/now-global-only' })];

    const merged = mergeKnownServerProjectMappings(existing, []);

    expect(merged).toEqual(existing);
  });

  it('lets a discovered entry with server info supersede a stale existing one lacking it, for the same targetRoot + projectKey', () => {
    const existing = [makeMapping({ serverUrl: undefined, orgKey: undefined })];
    const discovered = [makeMapping({ serverUrl: 'https://sonarqube.example.com' })];

    const merged = mergeKnownServerProjectMappings(existing, discovered);

    expect(merged).toEqual(discovered);
  });

  it('keeps the existing entry when the discovered one is not more complete', () => {
    const existing = [makeMapping({ serverUrl: 'https://sonarqube.example.com' })];
    const discovered = [makeMapping({ serverUrl: undefined, orgKey: undefined })];

    const merged = mergeKnownServerProjectMappings(existing, discovered);

    expect(merged).toEqual(existing);
  });

  it('keeps both entries when they share a targetRoot but resolve to different project keys, with discovered first', () => {
    // A genuine conflict, not a duplicate — left for match-time resolution.
    const existing = [makeMapping({ projectKey: 'old-project' })];
    const discovered = [makeMapping({ projectKey: 'new-project' })];

    const merged = mergeKnownServerProjectMappings(existing, discovered);

    expect(merged).toEqual([...discovered, ...existing]);
  });

  it('keeps two mappings with different targetRoots even when they share the same repoRoot', () => {
    // Two worktrees of the same repo, each with a different project key: the
    // shared repoRoot must not collapse them into one entry.
    const existing = [
      makeMapping({ targetRoot: '/main', repoRoot: '/main', projectKey: 'main-project' }),
      makeMapping({ targetRoot: '/worktree', repoRoot: '/main', projectKey: 'worktree-project' }),
    ];

    const merged = mergeKnownServerProjectMappings(existing, []);

    expect(merged).toEqual(existing);
  });
});

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

/** Builds mappings from a state with a single integration holding a single feature. */
function buildMappingsForFeature(
  featureOverrides: Partial<InstalledIntegrationFeature>,
  state: CliState = makeState(),
): KnownServerProjectMapping[] {
  state.integrations.installed = [makeIntegration([makeFeature(featureOverrides)])];
  return buildKnownServerProjectMappings(state);
}

describe('buildKnownServerProjectMappings', () => {
  it('skips global-scope features', () => {
    const mappings = buildMappingsForFeature({
      scope: 'global',
      attrs: { projectKey: 'proj', serverUrl: 'https://sonarqube.example.com' },
      targetRoot: '/home',
    });

    expect(mappings).toEqual([]);
  });

  it('skips features without an explicit projectKey attr', () => {
    const state = makeState();
    state.integrations.installed = [
      makeIntegration([makeFeature({ attrs: undefined }), makeFeature({ attrs: {} })]),
    ];

    const mappings = buildKnownServerProjectMappings(state);

    expect(mappings).toEqual([]);
  });

  it('records a mapping with serverUrl/orgKey left undefined when the feature never recorded a connection', () => {
    // Resolved later, at match time (discoverProject), not backfilled here — see
    // resolveMappingConnection in project-info.ts.
    const mappings = buildMappingsForFeature({ attrs: { projectKey: 'my-project' } });

    expect(mappings).toEqual([makeMapping({ serverUrl: undefined, orgKey: undefined })]);
  });

  it('records a mapping for a project-scoped feature with explicit projectKey/serverUrl attrs', () => {
    const mappings = buildMappingsForFeature({
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

  it('never backfills serverUrl/orgKey from the active connection, even when one exists (e.g. git integrate)', () => {
    // A stale point-in-time snapshot baked in here would go wrong once env-var auth
    // switches server/org per invocation — the substitution happens fresh at match time
    // in discoverProject() instead, not derivation time.
    const state = withActiveConnection(makeState(), {
      serverUrl: 'https://active-connection.example.com',
      orgKey: 'active-org',
    });

    const mappings = buildMappingsForFeature({ attrs: { projectKey: 'my-project' } }, state);

    expect(mappings).toEqual([makeMapping({ serverUrl: undefined, orgKey: undefined })]);
  });

  it('keeps the feature-recorded serverUrl/orgKey untouched even when a different connection is active', () => {
    const state = withActiveConnection(makeState(), {
      serverUrl: 'https://active-connection.example.com',
      orgKey: 'active-org',
    });

    const mappings = buildMappingsForFeature(
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

  it('copies a recorded repoRoot attr verbatim, without re-resolving or normalizing it', () => {
    const mappings = buildMappingsForFeature({
      targetRoot: '/linked-worktree',
      attrs: {
        projectKey: 'my-project',
        serverUrl: 'https://sonarqube.example.com',
        repoRoot: '/main',
      },
    });

    expect(mappings).toEqual([makeMapping({ targetRoot: '/linked-worktree', repoRoot: '/main' })]);
  });

  it('leaves repoRoot undefined when no repoRoot attr is recorded', () => {
    const mappings = buildMappingsForFeature({
      targetRoot: '/linked/worktree',
      attrs: { projectKey: 'my-project', serverUrl: 'https://sonarqube.example.com' },
    });

    expect(mappings).toEqual([makeMapping({ targetRoot: '/linked/worktree' })]);
    expect(mappings[0].repoRoot).toBeUndefined();
  });

  it('keeps two features with different targetRoots that share the same repoRoot attr (two worktrees)', () => {
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

    const mappings = buildKnownServerProjectMappings(state);

    expect(mappings.map((m) => m.projectKey).sort()).toEqual(['main-project', 'worktree-project']);
  });

  it('keeps the feature with server info when two features resolve to the same targetRoot and projectKey', () => {
    const state = makeState();
    state.integrations.installed = [
      makeIntegration([makeFeature({ attrs: { projectKey: 'my-project' } })], {
        integrationId: 'git',
      }),
      makeIntegration(
        [
          makeFeature({
            attrs: { projectKey: 'my-project', serverUrl: 'https://sonarqube.example.com' },
          }),
        ],
        { integrationId: 'claude-code' },
      ),
    ];

    const mappings = buildKnownServerProjectMappings(state);

    expect(mappings).toEqual([makeMapping({ serverUrl: 'https://sonarqube.example.com' })]);
  });

  it('keeps both features when they resolve to the same targetRoot but different project keys', () => {
    // Two agents integrated at the same folder, disagreeing on the project: a genuine
    // conflict, not a duplicate — left for match-time resolution, not silently collapsed.
    const state = makeState();
    state.integrations.installed = [
      makeIntegration([makeFeature({ attrs: { projectKey: 'old-project' } })], {
        integrationId: 'git',
      }),
      makeIntegration([makeFeature({ attrs: { projectKey: 'new-project' } })], {
        integrationId: 'claude-code',
      }),
    ];

    const mappings = buildKnownServerProjectMappings(state);

    expect(mappings.map((m) => m.projectKey).sort()).toEqual(['new-project', 'old-project']);
  });
});

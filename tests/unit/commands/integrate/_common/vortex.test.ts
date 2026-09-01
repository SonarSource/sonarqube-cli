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
  isVortexInstalledForOtherProject,
  VORTEX_FEATURE_ID,
} from '@/commands/integrate/_common/vortex.ts';
import type { CliState, InstalledIntegrationFeature } from '@/core/state/state.ts';

const INTEGRATION_ID = 'claude-code';

function fakeFeature(overrides: Partial<InstalledIntegrationFeature>): InstalledIntegrationFeature {
  return {
    featureId: VORTEX_FEATURE_ID,
    scope: 'project',
    targetRoot: '/repo-a',
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

function fakeState(features: InstalledIntegrationFeature[]): CliState {
  return {
    integrations: {
      installed: [
        {
          id: 'x',
          integrationId: INTEGRATION_ID,
          installedByCliVersion: '1.0.0',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedByCliVersion: '1.0.0',
          updatedAt: '2026-01-01T00:00:00.000Z',
          features,
        },
      ],
    },
  } as unknown as CliState;
}

describe('isVortexInstalledForOtherProject', () => {
  it('is false when no other project has a project-scope vortex record', () => {
    const state = fakeState([fakeFeature({ targetRoot: '/repo-a' })]);

    expect(isVortexInstalledForOtherProject(state, INTEGRATION_ID, '/repo-a')).toBe(false);
  });

  it('is true when another project still has a project-scope vortex record', () => {
    const state = fakeState([
      fakeFeature({ targetRoot: '/repo-a' }),
      fakeFeature({ targetRoot: '/repo-b' }),
    ]);

    expect(isVortexInstalledForOtherProject(state, INTEGRATION_ID, '/repo-a')).toBe(true);
  });

  it('ignores global-scope records — only project-scope vortex counts', () => {
    const state = fakeState([
      fakeFeature({ targetRoot: '/repo-a' }),
      fakeFeature({ scope: 'global', targetRoot: '/home/user' }),
    ]);

    expect(isVortexInstalledForOtherProject(state, INTEGRATION_ID, '/repo-a')).toBe(false);
  });

  it('ignores records for a different feature id', () => {
    const state = fakeState([
      fakeFeature({ targetRoot: '/repo-a' }),
      fakeFeature({ featureId: 'sonar-sqaa-hook', targetRoot: '/repo-b' }),
    ]);

    expect(isVortexInstalledForOtherProject(state, INTEGRATION_ID, '/repo-a')).toBe(false);
  });

  it('ignores records for a different integration', () => {
    const state = fakeState([fakeFeature({ targetRoot: '/repo-b' })]);

    expect(isVortexInstalledForOtherProject(state, 'codex', '/repo-a')).toBe(false);
  });

  it('is false when no integration entry exists at all', () => {
    const state = { integrations: { installed: [] } } as unknown as CliState;

    expect(isVortexInstalledForOtherProject(state, INTEGRATION_ID, '/repo-a')).toBe(false);
  });
});

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

import { CONTEXT_AUGMENTATION_SESSION_START_FEATURE_ID } from '@/commands/integrate/_common/features/context-augmentation-session-start-feature.ts';
import { VORTEX_FEATURE_ID } from '@/commands/integrate/_common/vortex.ts';
import { CODEX_INTEGRATION_ID, codexIntegration } from '@/commands/integrate/codex/declaration.ts';
import type { FeatureDeclaration, IntegrationInvocation } from '@/core/framework/features';
import type { CliState, InstalledIntegrationFeature } from '@/core/state/state.ts';

function sessionStartFeature(): FeatureDeclaration {
  const feature = codexIntegration.features.find(
    (f) => f.id === CONTEXT_AUGMENTATION_SESSION_START_FEATURE_ID,
  );
  if (!feature?.shouldInstall) {
    throw new Error('context-augmentation-session-start-hook feature or shouldInstall missing');
  }
  return feature;
}

function fakeVortexFeature(targetRoot: string): InstalledIntegrationFeature {
  return {
    featureId: VORTEX_FEATURE_ID,
    scope: 'project',
    targetRoot,
    installedByCliVersion: '1.0.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedByCliVersion: '1.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
    dependencies: [],
    resources: [],
    operations: [],
  };
}

function fakeState(features: InstalledIntegrationFeature[]): CliState {
  return {
    integrations: {
      installed: [
        {
          id: 'x',
          integrationId: CODEX_INTEGRATION_ID,
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

function fakeInvocation(overrides: Partial<IntegrationInvocation>): IntegrationInvocation {
  return {
    options: { vortexDisposition: 'remove' },
    targetRoot: '/repo-a',
    scope: 'project',
    state: fakeState([]),
    ...overrides,
  } as unknown as IntegrationInvocation;
}

describe('codex declaration — context-augmentation-session-start-hook shouldInstall', () => {
  it('is wired to the Codex integration id: skips (leaves installed) when another project still has vortex', async () => {
    const feature = sessionStartFeature();
    const invocation = fakeInvocation({
      options: { vortexDisposition: 'remove' },
      targetRoot: '/repo-a',
      state: fakeState([fakeVortexFeature('/repo-b')]),
    });

    const decision = await feature.shouldInstall!(invocation);

    expect(decision).toMatchObject({ action: 'skip' });
  });

  it('still installs for a second project even though another project already has vortex', async () => {
    const feature = sessionStartFeature();
    const invocation = fakeInvocation({
      options: { vortexDisposition: 'install' },
      targetRoot: '/repo-b',
      state: fakeState([fakeVortexFeature('/repo-a')]),
    });

    const decision = await feature.shouldInstall!(invocation);

    expect(decision).toMatchObject({ action: 'install' });
  });

  it('still installs on a --global run even though a project already has vortex', async () => {
    const feature = sessionStartFeature();
    const invocation = fakeInvocation({
      options: { vortexDisposition: 'install' },
      scope: 'global',
      targetRoot: '/home/user',
      state: fakeState([fakeVortexFeature('/repo-a')]),
    });

    const decision = await feature.shouldInstall!(invocation);

    expect(decision).toMatchObject({ action: 'install' });
  });
});

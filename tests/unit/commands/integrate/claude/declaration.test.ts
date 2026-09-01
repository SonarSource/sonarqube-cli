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
import {
  CLAUDE_INTEGRATION_ID,
  claudeIntegration,
} from '@/commands/integrate/claude/declaration.ts';
import type { FeatureDeclaration, IntegrationInvocation } from '@/core/framework/features';
import type { CliState, InstalledIntegrationFeature } from '@/core/state/state.ts';

function sessionStartFeature(): FeatureDeclaration {
  const feature = claudeIntegration.features.find(
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
          integrationId: CLAUDE_INTEGRATION_ID,
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

describe('claude declaration — context-augmentation-session-start-hook shouldInstall', () => {
  it('skips (leaves installed) when another project still has vortex, even on a remove disposition', async () => {
    const feature = sessionStartFeature();
    const invocation = fakeInvocation({
      options: { vortexDisposition: 'remove' },
      targetRoot: '/repo-a',
      state: fakeState([fakeVortexFeature('/repo-b')]),
    });

    const decision = await feature.shouldInstall!(invocation);

    expect(decision).toMatchObject({ action: 'skip' });
  });

  it('falls through to the normal CAG-hook decision when no other project has vortex', async () => {
    const feature = sessionStartFeature();
    const invocation = fakeInvocation({
      options: { vortexDisposition: 'remove' },
      targetRoot: '/repo-a',
      state: fakeState([fakeVortexFeature('/repo-a')]),
    });

    const decision = await feature.shouldInstall!(invocation);

    // Only this project (about to be removed) has vortex — no OTHER project depends on the
    // shared hook, so the normal disposition-driven decision (uninstall) applies.
    expect(decision).toMatchObject({ action: 'uninstall' });
  });

  it('installs for an allowlisted org when no other project has vortex', async () => {
    const feature = sessionStartFeature();
    const invocation = fakeInvocation({
      options: { vortexDisposition: 'install' },
      attrs: { orgKey: 'sonarsource' },
      targetRoot: '/repo-a',
      state: fakeState([]),
    });

    const decision = await feature.shouldInstall!(invocation);

    expect(decision).toMatchObject({ action: 'install' });
  });

  it('skips install for a non-allowlisted org', async () => {
    const feature = sessionStartFeature();
    const invocation = fakeInvocation({
      options: { vortexDisposition: 'install' },
      attrs: { orgKey: 'some-other-org' },
      targetRoot: '/repo-a',
      state: fakeState([]),
    });

    const decision = await feature.shouldInstall!(invocation);

    expect(decision).toMatchObject({ action: 'skip' });
  });
});

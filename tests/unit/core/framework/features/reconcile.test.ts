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

import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  type ContainerIntegrationContext,
  type DependencyDeclaration,
  type FeatureContainer,
  type IntegrationContext,
  IntegrationRegistry,
  reconcileInstalledIntegrations,
  wholeFile,
} from '@/core/framework/features';
import type { CliState } from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

let fake: FakeConsole;

beforeEach(() => {
  fake = new FakeConsole();
});

function makeState(): CliState {
  return getDefaultState('1.0.0');
}

describe('reconcileInstalledIntegrations', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'sonar-cli-reconcile-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reapplies only installed declarative features and prunes unknown feature state', async () => {
    const operationCalls: string[] = [];
    const resourcePath = join(tempDir, 'managed.txt');
    const newFeatureResourcePath = join(tempDir, 'new-feature.txt');
    const now = '2026-01-01T00:00:00.000Z';
    fs.writeFileSync(resourcePath, 'legacy content', 'utf-8');

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
          featureId: 'managed-feature',
          scope: 'project',
          targetRoot: tempDir,
          installedByCliVersion: '0.9.0',
          installedAt: now,
          updatedByCliVersion: '0.9.0',
          updatedAt: now,
          dependencies: [],
          resources: [
            {
              id: 'managed-file',
              resourceType: 'whole-file',
              version: '1',
              path: resourcePath,
              updatedByCliVersion: '0.9.0',
              updatedAt: now,
            },
          ],
          operations: [],
          attrs: { projectKey: 'project-key' },
        },
        {
          featureId: 'removed-feature',
          scope: 'project',
          targetRoot: tempDir,
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

    const registry = new IntegrationRegistry();
    registry.register({
      id: 'test-integration',
      displayName: 'Test integration',
      features: [
        {
          id: 'managed-feature',
          displayName: 'Managed feature',
          resources: [
            wholeFile({
              id: 'managed-file',
              version: '2',
              targetPath: resourcePath,
              content: 'fresh content',
            }),
          ],
          operations: [
            {
              id: 'refresh-operation',
              version: '1',
              apply: () => {
                operationCalls.push('refresh-operation');
              },
            },
          ],
        },
        {
          id: 'new-feature',
          displayName: 'New feature',
          resources: [
            wholeFile({
              id: 'new-managed-file',
              version: '1',
              targetPath: newFeatureResourcePath,
              content: 'should not be written automatically',
            }),
          ],
          operations: [
            {
              id: 'new-feature-operation',
              version: '1',
              apply: () => {
                operationCalls.push('new-feature-operation');
              },
            },
          ],
        },
      ],
    });

    const changed = await reconcileInstalledIntegrations(state, registry, fake);

    expect(fs.readFileSync(resourcePath, 'utf-8')).toBe('fresh content');
    expect(operationCalls).toEqual(['refresh-operation']);
    expect(fs.existsSync(newFeatureResourcePath)).toBe(false);
    expect(changed).toBe(true);

    expect(state.integrations.installed).toHaveLength(1);
    expect(state.integrations.installed[0].features).toHaveLength(1);
    const savedFeature = state.integrations.installed[0].features[0];
    expect(savedFeature.featureId).toBe('managed-feature');
    expect(savedFeature.resources).toHaveLength(1);
    expect(savedFeature.resources[0]).toMatchObject({
      id: 'managed-file',
      version: '2',
      path: resourcePath,
    });
    expect(savedFeature.operations).toHaveLength(1);
    expect(savedFeature.operations[0]).toMatchObject({
      id: 'refresh-operation',
      version: '1',
    });
  });

  it('installs a shared dependency once and exposes the refreshed dependency to feature resources', async () => {
    const dependencyPathA = join(tempDir, 'feature-a.txt');
    const dependencyPathB = join(tempDir, 'feature-b.txt');
    const existingDependencyPaths: string[] = [];
    const installCalls: string[] = [];
    const now = '2026-01-01T00:00:00.000Z';

    const sharedDependency: DependencyDeclaration = {
      id: 'shared-dependency',
      version: '2',
      installOrUpdate: ({ existingDependency }) => {
        existingDependencyPaths.push(existingDependency?.path ?? 'missing');
        installCalls.push('install');
        return {
          id: 'shared-dependency',
          version: '2',
          path: '/new/shared-dependency',
        };
      },
      isInstalled: () => true,
      remove: () => {},
    };

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
          featureId: 'feature-a',
          scope: 'project',
          targetRoot: tempDir,
          installedByCliVersion: '0.9.0',
          installedAt: now,
          updatedByCliVersion: '0.9.0',
          updatedAt: now,
          dependencies: [{ id: sharedDependency.id }],
          resources: [],
          operations: [],
        },
        {
          featureId: 'feature-b',
          scope: 'project',
          targetRoot: tempDir,
          installedByCliVersion: '0.9.0',
          installedAt: now,
          updatedByCliVersion: '0.9.0',
          updatedAt: now,
          dependencies: [{ id: sharedDependency.id }],
          resources: [],
          operations: [],
        },
      ],
    });
    state.dependencies.installed.push({
      id: sharedDependency.id,
      version: '1',
      path: '/old/shared-dependency',
      updatedByCliVersion: '0.9.0',
      updatedAt: now,
    });

    const registry = new IntegrationRegistry();
    registry.register({
      id: 'test-integration',
      displayName: 'Test integration',
      features: [
        {
          id: 'feature-a',
          displayName: 'Feature A',
          dependencies: [sharedDependency],
          resources: [
            wholeFile({
              id: 'feature-a-file',
              version: '1',
              targetPath: dependencyPathA,
              content: (context: IntegrationContext) =>
                String(context.resolvedDependencies.get(sharedDependency.id)?.path),
            }),
          ],
        },
        {
          id: 'feature-b',
          displayName: 'Feature B',
          dependencies: [sharedDependency],
          resources: [
            wholeFile({
              id: 'feature-b-file',
              version: '1',
              targetPath: dependencyPathB,
              content: (context: IntegrationContext) =>
                String(context.resolvedDependencies.get(sharedDependency.id)?.path),
            }),
          ],
        },
      ],
    });

    const changed = await reconcileInstalledIntegrations(state, registry, fake);

    expect(existingDependencyPaths).toEqual(['/old/shared-dependency']);
    expect(installCalls).toEqual(['install']);
    expect(fs.readFileSync(dependencyPathA, 'utf-8')).toBe('/new/shared-dependency');
    expect(fs.readFileSync(dependencyPathB, 'utf-8')).toBe('/new/shared-dependency');
    expect(changed).toBe(true);
  });

  it('activates only migrationDefaultSubfeatureIds when upgrading from old plain-feature state', async () => {
    const capturedContexts: IntegrationContext[] = [];
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
          featureId: 'container-feature',
          scope: 'project',
          targetRoot: tempDir,
          installedByCliVersion: '0.9.0',
          installedAt: now,
          updatedByCliVersion: '0.9.0',
          updatedAt: now,
          dependencies: [],
          resources: [],
          operations: [],
          // no subfeatures — simulates an old plain-feature install
        },
      ],
    });

    const container: FeatureContainer = {
      id: 'container-feature',
      displayName: 'Container feature',
      defaultInstallSubfeatureIds: ['sub-a'],
      subfeatures: [
        { id: 'sub-a', displayName: 'Sub A' },
        { id: 'sub-b', displayName: 'Sub B' },
      ],
      operations: [
        {
          id: 'test-op',
          apply: (ctx) => {
            capturedContexts.push(ctx);
          },
        },
      ],
    };
    const registry = new IntegrationRegistry();
    registry.register({
      id: 'test-integration',
      displayName: 'Test integration',
      features: [container],
    });

    await reconcileInstalledIntegrations(state, registry, fake);

    expect(capturedContexts).toHaveLength(1);
    expect('activeSubfeatures' in capturedContexts[0]).toBeTrue();
    expect(
      (capturedContexts[0] as ContainerIntegrationContext).activeSubfeatures.map((s) => s.id),
    ).toEqual(['sub-a']);

    const savedFeature = state.integrations.installed[0].features[0];
    expect(savedFeature.subfeatures).toHaveLength(1);
    expect(savedFeature.subfeatures![0]).toMatchObject({ featureId: 'sub-a' });
  });

  it('restores previously active container subfeatures from recorded state, excluding newly added ones', async () => {
    const capturedContexts: IntegrationContext[] = [];
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
          featureId: 'container-feature',
          scope: 'project',
          targetRoot: tempDir,
          installedByCliVersion: '0.9.0',
          installedAt: now,
          updatedByCliVersion: '0.9.0',
          updatedAt: now,
          dependencies: [],
          resources: [],
          operations: [],
          subfeatures: [{ featureId: 'sub-a', dependencies: [] }],
        },
      ],
    });

    const container: FeatureContainer = {
      id: 'container-feature',
      displayName: 'Container feature',
      subfeatures: [
        { id: 'sub-a', displayName: 'Sub A' },
        { id: 'sub-b', displayName: 'Sub B' },
        { id: 'sub-c', displayName: 'Sub C' }, // newly added, not in recorded state
      ],
      defaultInstallSubfeatureIds: ['sub-b'],
      operations: [
        {
          id: 'test-op',
          apply: (ctx) => {
            capturedContexts.push(ctx);
          },
        },
      ],
    };
    const registry = new IntegrationRegistry();
    registry.register({
      id: 'test-integration',
      displayName: 'Test integration',
      features: [container],
    });

    await reconcileInstalledIntegrations(state, registry, fake);

    expect(capturedContexts).toHaveLength(1);
    expect(
      (capturedContexts[0] as ContainerIntegrationContext).activeSubfeatures.map((s) => s.id),
    ).toEqual(['sub-a']);

    const savedFeature = state.integrations.installed[0].features[0];
    expect(savedFeature.subfeatures).toHaveLength(1);
    expect(savedFeature.subfeatures![0]).toMatchObject({ featureId: 'sub-a' });
  });

  it('refreshes recorded subfeature resources and skips newly added subfeature resources', async () => {
    const now = '2026-01-01T00:00:00.000Z';
    const recordedPath = join(tempDir, 'recorded-sub.txt');
    const newPath = join(tempDir, 'new-sub.txt');

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
          featureId: 'container-feature',
          scope: 'project',
          targetRoot: tempDir,
          installedByCliVersion: '0.9.0',
          installedAt: now,
          updatedByCliVersion: '0.9.0',
          updatedAt: now,
          dependencies: [],
          resources: [],
          operations: [],
          subfeatures: [{ featureId: 'sub-a', dependencies: [] }],
        },
      ],
    });

    const container: FeatureContainer = {
      id: 'container-feature',
      displayName: 'Container feature',
      subfeatures: [
        {
          id: 'sub-a',
          displayName: 'Sub A',
          resources: [wholeFile({ id: 'sub-a-file', targetPath: recordedPath, content: 'a' })],
        },
        // Never opted into, so update must not install it.
        {
          id: 'sub-b',
          displayName: 'Sub B',
          resources: [wholeFile({ id: 'sub-b-file', targetPath: newPath, content: 'b' })],
        },
      ],
      defaultInstallSubfeatureIds: [],
    };
    const registry = new IntegrationRegistry();
    registry.register({
      id: 'test-integration',
      displayName: 'Test integration',
      features: [container],
    });

    await reconcileInstalledIntegrations(state, registry, fake);

    expect(fs.readFileSync(recordedPath, 'utf-8')).toBe('a');
    expect(fs.existsSync(newPath)).toBeFalse();

    const savedFeature = state.integrations.installed[0].features[0];
    expect(savedFeature.subfeatures![0].resources!.map((r) => r.id)).toEqual(['sub-a-file']);
  });

  it('applies plain feature normally when old state has container subfeatures recorded', async () => {
    const capturedContexts: IntegrationContext[] = [];
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
          featureId: 'plain-feature',
          scope: 'project',
          targetRoot: tempDir,
          installedByCliVersion: '0.9.0',
          installedAt: now,
          updatedByCliVersion: '0.9.0',
          updatedAt: now,
          dependencies: [],
          resources: [],
          operations: [],
          subfeatures: [{ featureId: 'old-sub', dependencies: [] }],
        },
      ],
    });

    const registry = new IntegrationRegistry();
    registry.register({
      id: 'test-integration',
      displayName: 'Test integration',
      features: [
        {
          id: 'plain-feature',
          displayName: 'Plain feature',
          operations: [
            {
              id: 'test-op',
              apply: (ctx) => {
                capturedContexts.push(ctx);
              },
            },
          ],
        },
      ],
    });

    await reconcileInstalledIntegrations(state, registry, fake);

    expect(capturedContexts).toHaveLength(1);
    expect('activeSubfeatures' in capturedContexts[0]).toBeFalse();
  });

  function recordedReplaceableFeature(
    featureId: string,
    attrs: Record<string, string | boolean> | undefined,
    targetRoot: string,
  ) {
    const now = '2026-01-01T00:00:00.000Z';
    return {
      featureId,
      scope: 'project' as const,
      targetRoot,
      installedByCliVersion: '0.9.0',
      installedAt: now,
      updatedByCliVersion: '0.9.0',
      updatedAt: now,
      dependencies: [],
      resources: [],
      operations: [],
      attrs,
    };
  }

  it('migrates replaced features into one successor with merged attrs', async () => {
    const appliedAttrs: (IntegrationContext['attrs'] | undefined)[] = [];
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
        recordedReplaceableFeature('old-sqaa', { projectKey: 'project-key' }, tempDir),
        recordedReplaceableFeature('old-context', { orgKey: 'org-key', scaEnabled: true }, tempDir),
      ],
    });

    const registry = new IntegrationRegistry();
    registry.register({
      id: 'test-integration',
      displayName: 'Test integration',
      features: [
        {
          id: 'vortex',
          displayName: 'Vortex',
          replacedIds: ['old-sqaa', 'old-context'],
          operations: [
            {
              id: 'vortex-operation',
              apply: (context) => {
                appliedAttrs.push(context.attrs);
              },
            },
          ],
        },
      ],
    });

    await reconcileInstalledIntegrations(state, registry, fake);

    expect(appliedAttrs).toEqual([
      { projectKey: 'project-key', orgKey: 'org-key', scaEnabled: true },
    ]);
    expect(state.integrations.installed[0].features).toHaveLength(1);
    expect(state.integrations.installed[0].features[0]).toMatchObject({
      featureId: 'vortex',
      attrs: { projectKey: 'project-key', orgKey: 'org-key', scaEnabled: true },
    });
  });

  it('merges predecessor attrs in successor replacement order', async () => {
    const appliedAttrs: (IntegrationContext['attrs'] | undefined)[] = [];
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
        recordedReplaceableFeature('old-context', { projectKey: 'context-project' }, tempDir),
        recordedReplaceableFeature('old-sqaa', { projectKey: 'sqaa-project' }, tempDir),
      ],
    });

    const registry = new IntegrationRegistry();
    registry.register({
      id: 'test-integration',
      displayName: 'Test integration',
      features: [
        {
          id: 'vortex',
          displayName: 'Vortex',
          replacedIds: ['old-sqaa', 'old-context'],
          operations: [
            {
              id: 'vortex-operation',
              apply: (context) => {
                appliedAttrs.push(context.attrs);
              },
            },
          ],
        },
      ],
    });

    await reconcileInstalledIntegrations(state, registry, fake);

    expect(appliedAttrs).toEqual([{ projectKey: 'context-project' }]);
  });

  it('reapplies a recorded successor without merging predecessor attrs', async () => {
    const appliedAttrs: (IntegrationContext['attrs'] | undefined)[] = [];
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
        recordedReplaceableFeature('old-context', { orgKey: 'old-org' }, tempDir),
        recordedReplaceableFeature('vortex', { projectKey: 'project-key' }, tempDir),
      ],
    });

    const registry = new IntegrationRegistry();
    registry.register({
      id: 'test-integration',
      displayName: 'Test integration',
      features: [
        {
          id: 'vortex',
          displayName: 'Vortex',
          replacedIds: ['old-context'],
          operations: [
            {
              id: 'vortex-operation',
              apply: (context) => {
                appliedAttrs.push(context.attrs);
              },
            },
          ],
        },
      ],
    });

    await reconcileInstalledIntegrations(state, registry, fake);

    expect(appliedAttrs).toEqual([{ projectKey: 'project-key' }]);
    expect(state.integrations.installed[0].features).toHaveLength(1);
    expect(state.integrations.installed[0].features[0].featureId).toBe('vortex');
  });
});

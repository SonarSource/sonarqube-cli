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
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'sonar-cli-reconcile-'));
    // Sandbox os.homedir() — folding a lone project entry into global falls back to it.
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
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
          scope: 'project',
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
          scope: 'project',
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
          scope: 'project',
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
          scope: 'project',
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
      scope: 'project',
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
      scope: 'project',
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
      scope: 'project',
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
          scope: 'project',
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
          scope: 'project',
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
          scope: 'project',
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
          scope: 'project',
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

  describe('global-scope coexistence collapsing', () => {
    function recordedCoexistingFeature(
      featureId: string,
      scope: 'global' | 'project',
      targetRoot: string,
      attrs: Record<string, string> | undefined,
      subfeatures?: { featureId: string; dependencies: [] }[],
    ) {
      const now = '2026-01-01T00:00:00.000Z';
      return {
        featureId,
        scope,
        targetRoot,
        installedByCliVersion: '0.9.0',
        installedAt: now,
        updatedByCliVersion: '0.9.0',
        updatedAt: now,
        dependencies: [],
        resources: [],
        operations: [],
        attrs,
        subfeatures,
      };
    }

    it('collapses a coexisting project install into the global one, merging attrs and removing the stale project file', async () => {
      const globalDir = join(tempDir, 'global');
      const projectDir = join(tempDir, 'project');
      fs.mkdirSync(globalDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });

      const state = makeState();
      state.integrations.installed.push({
        id: 'integration-id',
        integrationId: 'test-integration',
        installedByCliVersion: '0.9.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '0.9.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
        features: [
          recordedCoexistingFeature('managed-feature', 'global', globalDir, { orgKey: 'org' }),
          recordedCoexistingFeature('managed-feature', 'project', projectDir, {
            projectKey: 'proj',
          }),
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
                version: '1',
                targetPath: (ctx) => join(ctx.targetRoot, 'managed.txt'),
                content: (ctx) => JSON.stringify(ctx.attrs),
              }),
            ],
          },
        ],
      });

      const changed = await reconcileInstalledIntegrations(state, registry, fake);

      expect(changed).toBe(true);
      expect(fs.existsSync(join(projectDir, 'managed.txt'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(join(globalDir, 'managed.txt'), 'utf-8'))).toEqual({
        orgKey: 'org',
        projectKey: 'proj',
      });

      expect(state.integrations.installed[0].features).toHaveLength(1);
      expect(state.integrations.installed[0].features[0]).toMatchObject({
        featureId: 'managed-feature',
        scope: 'global',
        attrs: { orgKey: 'org', projectKey: 'proj' },
      });
    });

    it('collapses every coexisting project install (not just one) into the same global record', async () => {
      const globalDir = join(tempDir, 'global');
      const projectDirA = join(tempDir, 'project-a');
      const projectDirB = join(tempDir, 'project-b');
      fs.mkdirSync(globalDir, { recursive: true });
      fs.mkdirSync(projectDirA, { recursive: true });
      fs.mkdirSync(projectDirB, { recursive: true });

      const state = makeState();
      state.integrations.installed.push({
        id: 'integration-id',
        integrationId: 'test-integration',
        installedByCliVersion: '0.9.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '0.9.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
        features: [
          recordedCoexistingFeature('managed-feature', 'global', globalDir, { orgKey: 'org' }),
          recordedCoexistingFeature('managed-feature', 'project', projectDirA, {
            projectKey: 'proj-a',
          }),
          recordedCoexistingFeature('managed-feature', 'project', projectDirB, {
            projectKey: 'proj-b',
          }),
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
                version: '1',
                targetPath: (ctx) => join(ctx.targetRoot, 'managed.txt'),
                content: (ctx) => JSON.stringify(ctx.attrs),
              }),
            ],
          },
        ],
      });

      const changed = await reconcileInstalledIntegrations(state, registry, fake);

      expect(changed).toBe(true);
      expect(fs.existsSync(join(projectDirA, 'managed.txt'))).toBe(false);
      expect(fs.existsSync(join(projectDirB, 'managed.txt'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(join(globalDir, 'managed.txt'), 'utf-8'))).toEqual({
        orgKey: 'org',
        projectKey: 'proj-b',
      });

      expect(state.integrations.installed[0].features).toHaveLength(1);
      expect(state.integrations.installed[0].features[0]).toMatchObject({
        featureId: 'managed-feature',
        scope: 'global',
        attrs: { orgKey: 'org', projectKey: 'proj-b' },
      });
    });

    it('leaves a stale project install alone when it is still recorded under a replacedIds predecessor id (its rename migration failed and is pending retry)', async () => {
      const globalDir = join(tempDir, 'global');
      const projectDir = join(tempDir, 'project');
      fs.mkdirSync(globalDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(join(projectDir, 'managed.txt'), 'stale-legacy-content');

      const state = makeState();
      state.integrations.installed.push({
        id: 'integration-id',
        integrationId: 'test-integration',
        installedByCliVersion: '0.9.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '0.9.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
        features: [
          recordedCoexistingFeature('managed-feature', 'global', globalDir, { orgKey: 'org' }),
          recordedCoexistingFeature('legacy-feature', 'project', projectDir, {
            projectKey: 'proj',
          }),
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
            replacedIds: ['legacy-feature'],
            resources: [
              wholeFile({
                id: 'managed-file',
                version: '1',
                targetPath: (ctx) => join(ctx.targetRoot, 'managed.txt'),
                // Fail the project-scope rename so it rolls back under the predecessor id.
                content: (ctx) => {
                  if (ctx.scope === 'project') {
                    throw new Error('simulated rename-in-place failure');
                  }
                  return JSON.stringify(ctx.attrs);
                },
              }),
            ],
          },
        ],
      });

      await reconcileInstalledIntegrations(state, registry, fake);

      expect(fs.readFileSync(join(projectDir, 'managed.txt'), 'utf-8')).toBe(
        'stale-legacy-content',
      );
      expect(JSON.parse(fs.readFileSync(join(globalDir, 'managed.txt'), 'utf-8'))).toEqual({
        orgKey: 'org',
      });

      expect(state.integrations.installed[0].features).toHaveLength(2);
      const legacyEntry = state.integrations.installed[0].features.find(
        (feature) => feature.featureId === 'legacy-feature',
      );
      expect(legacyEntry).toMatchObject({
        scope: 'project',
        targetRoot: projectDir,
        attrs: { projectKey: 'proj' },
      });
    });

    it('produces a fresh global record from a lone project install when no global one exists', async () => {
      const projectDir = join(tempDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });

      const state = makeState();
      state.integrations.installed.push({
        id: 'integration-id',
        integrationId: 'test-integration',
        installedByCliVersion: '0.9.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '0.9.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
        features: [
          recordedCoexistingFeature('managed-feature', 'project', projectDir, {
            projectKey: 'proj',
          }),
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
                version: '1',
                targetPath: (ctx) => join(ctx.targetRoot, 'managed.txt'),
                content: 'content',
              }),
            ],
          },
        ],
      });

      await reconcileInstalledIntegrations(state, registry, fake);

      expect(fs.existsSync(join(projectDir, 'managed.txt'))).toBe(false);
      expect(fs.readFileSync(join(tempDir, 'managed.txt'), 'utf-8')).toBe('content');

      expect(state.integrations.installed[0].features).toHaveLength(1);
      expect(state.integrations.installed[0].features[0]).toMatchObject({
        featureId: 'managed-feature',
        scope: 'global',
        targetRoot: tempDir,
        attrs: { projectKey: 'proj' },
      });
    });

    it('never produces a global record for a feature declared project-scope only, even with no coexisting global', async () => {
      const projectDir = join(tempDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });

      const state = makeState();
      state.integrations.installed.push({
        id: 'integration-id',
        integrationId: 'test-integration',
        installedByCliVersion: '0.9.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '0.9.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
        features: [
          recordedCoexistingFeature('project-only-feature', 'project', projectDir, {
            projectKey: 'proj',
          }),
        ],
      });

      const registry = new IntegrationRegistry();
      registry.register({
        id: 'test-integration',
        displayName: 'Test integration',
        features: [
          {
            id: 'project-only-feature',
            displayName: 'Project-only feature',
            scope: 'project',
          },
        ],
      });

      await reconcileInstalledIntegrations(state, registry, fake);

      expect(state.integrations.installed[0].features).toHaveLength(1);
      expect(state.integrations.installed[0].features[0].scope).toBe('project');
    });

    it('merges attrs from every lone project install into one fresh global record', async () => {
      const projectDirA = join(tempDir, 'project-a');
      const projectDirB = join(tempDir, 'project-b');
      fs.mkdirSync(projectDirA, { recursive: true });
      fs.mkdirSync(projectDirB, { recursive: true });

      const state = makeState();
      state.integrations.installed.push({
        id: 'integration-id',
        integrationId: 'test-integration',
        installedByCliVersion: '0.9.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '0.9.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
        features: [
          recordedCoexistingFeature('managed-feature', 'project', projectDirA, {
            projectKey: 'proj-a',
          }),
          recordedCoexistingFeature('managed-feature', 'project', projectDirB, {
            projectKey: 'proj-b',
          }),
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
                version: '1',
                targetPath: (ctx) => join(ctx.targetRoot, 'managed.txt'),
                content: (ctx) => JSON.stringify(ctx.attrs),
              }),
            ],
          },
        ],
      });

      await reconcileInstalledIntegrations(state, registry, fake);

      expect(fs.existsSync(join(projectDirA, 'managed.txt'))).toBe(false);
      expect(fs.existsSync(join(projectDirB, 'managed.txt'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(join(tempDir, 'managed.txt'), 'utf-8'))).toEqual({
        projectKey: 'proj-b',
      });
      expect(state.integrations.installed[0].features).toHaveLength(1);
      expect(state.integrations.installed[0].features[0].scope).toBe('global');
    });

    it('drops a project-pinned subfeature when promoting a lone project install with no coexisting global', async () => {
      const projectDir = join(tempDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });

      const state = makeState();
      state.integrations.installed.push({
        id: 'integration-id',
        integrationId: 'test-integration',
        installedByCliVersion: '0.9.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '0.9.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
        features: [
          recordedCoexistingFeature('container-feature', 'project', projectDir, undefined, [
            { featureId: 'sub-a', dependencies: [] },
            { featureId: 'project-only-sub', dependencies: [] },
          ]),
        ],
      });

      const container: FeatureContainer = {
        id: 'container-feature',
        displayName: 'Container feature',
        subfeatures: [
          { id: 'sub-a', displayName: 'Sub A' },
          { id: 'project-only-sub', displayName: 'Project-only sub', scope: 'project' },
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

      const promoted = state.integrations.installed[0].features[0];
      expect(promoted.scope).toBe('global');
      expect((promoted.subfeatures ?? []).map((s) => s.featureId)).toEqual(['sub-a']);
    });

    it('installs a global-only subfeature via shouldInstall even though it was never active before', async () => {
      const projectDir = join(tempDir, 'project');
      fs.mkdirSync(projectDir, { recursive: true });
      const shouldInstallInvocations: unknown[] = [];

      const state = makeState();
      state.integrations.installed.push({
        id: 'integration-id',
        integrationId: 'test-integration',
        installedByCliVersion: '0.9.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '0.9.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
        features: [
          recordedCoexistingFeature('container-feature', 'project', projectDir, {
            projectKey: 'proj',
          }),
        ],
      });

      const container: FeatureContainer = {
        id: 'container-feature',
        displayName: 'Container feature',
        subfeatures: [
          {
            id: 'global-only-sub',
            displayName: 'Global-only sub',
            scope: 'global',
            shouldInstall: (invocation) => {
              shouldInstallInvocations.push(invocation);
              return true;
            },
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

      const promoted = state.integrations.installed[0].features[0];
      expect(promoted.scope).toBe('global');
      expect((promoted.subfeatures ?? []).map((s) => s.featureId)).toEqual(['global-only-sub']);
      expect(shouldInstallInvocations).toEqual([
        expect.objectContaining({
          scope: 'global',
          targetRoot: tempDir,
          attrs: { projectKey: 'proj' },
          nonInteractive: true,
        }),
      ]);
    });

    it('preserves a global-only subfeature recorded active on an existing global record, without re-running its shouldInstall', async () => {
      const globalDir = join(tempDir, 'global');
      const projectDir = join(tempDir, 'project');
      fs.mkdirSync(globalDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });
      const shouldInstallInvocations: unknown[] = [];

      const state = makeState();
      state.integrations.installed.push({
        id: 'integration-id',
        integrationId: 'test-integration',
        installedByCliVersion: '0.9.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '0.9.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
        features: [
          recordedCoexistingFeature('container-feature', 'global', globalDir, undefined, [
            { featureId: 'global-only-sub', dependencies: [] },
          ]),
          recordedCoexistingFeature('container-feature', 'project', projectDir, undefined),
        ],
      });

      const container: FeatureContainer = {
        id: 'container-feature',
        displayName: 'Container feature',
        subfeatures: [
          {
            id: 'global-only-sub',
            displayName: 'Global-only sub',
            scope: 'global',
            shouldInstall: (invocation) => {
              shouldInstallInvocations.push(invocation);
              return false;
            },
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

      expect(shouldInstallInvocations).toEqual([]);

      const collapsed = state.integrations.installed[0].features[0];
      expect(collapsed.scope).toBe('global');
      expect((collapsed.subfeatures ?? []).map((s) => s.featureId)).toEqual(['global-only-sub']);
    });

    it('never collapses a feature declared project-scope only, even when a global record coexists', async () => {
      const globalDir = join(tempDir, 'global');
      const projectDir = join(tempDir, 'project');
      fs.mkdirSync(globalDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });

      const state = makeState();
      state.integrations.installed.push({
        id: 'integration-id',
        integrationId: 'test-integration',
        installedByCliVersion: '0.9.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '0.9.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
        features: [
          recordedCoexistingFeature('project-only-feature', 'global', globalDir, {
            orgKey: 'org',
          }),
          recordedCoexistingFeature('project-only-feature', 'project', projectDir, {
            projectKey: 'proj',
          }),
        ],
      });

      const registry = new IntegrationRegistry();
      registry.register({
        id: 'test-integration',
        displayName: 'Test integration',
        features: [
          {
            id: 'project-only-feature',
            displayName: 'Project-only feature',
            scope: 'project',
          },
        ],
      });

      await reconcileInstalledIntegrations(state, registry, fake);

      expect(state.integrations.installed[0].features).toHaveLength(2);
      expect(state.integrations.installed[0].features.map((f) => f.scope).sort()).toEqual([
        'global',
        'project',
      ]);
    });

    it('unions active subfeatures across the coexisting global and project installs when collapsing', async () => {
      const globalDir = join(tempDir, 'global');
      const projectDir = join(tempDir, 'project');
      fs.mkdirSync(globalDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });
      const capturedContexts: IntegrationContext[] = [];

      const state = makeState();
      state.integrations.installed.push({
        id: 'integration-id',
        integrationId: 'test-integration',
        installedByCliVersion: '0.9.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '0.9.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
        features: [
          recordedCoexistingFeature('container-feature', 'global', globalDir, undefined, [
            { featureId: 'sub-a', dependencies: [] },
          ]),
          recordedCoexistingFeature('container-feature', 'project', projectDir, undefined, [
            { featureId: 'sub-b', dependencies: [] },
          ]),
        ],
      });

      const container: FeatureContainer = {
        id: 'container-feature',
        displayName: 'Container feature',
        subfeatures: [
          { id: 'sub-a', displayName: 'Sub A' },
          { id: 'sub-b', displayName: 'Sub B' },
        ],
        defaultInstallSubfeatureIds: [],
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

      expect(state.integrations.installed[0].features).toHaveLength(1);
      const collapsedFeature = state.integrations.installed[0].features[0];
      expect(collapsedFeature.scope).toBe('global');
      expect((collapsedFeature.subfeatures ?? []).map((s) => s.featureId).sort()).toEqual([
        'sub-a',
        'sub-b',
      ]);

      const lastContext = capturedContexts[
        capturedContexts.length - 1
      ] as ContainerIntegrationContext;
      expect(lastContext.activeSubfeatures.map((s) => s.id).sort()).toEqual(['sub-a', 'sub-b']);
    });

    it('drops a project-pinned subfeature from the union instead of carrying it onto the global record', async () => {
      const globalDir = join(tempDir, 'global');
      const projectDir = join(tempDir, 'project');
      fs.mkdirSync(globalDir, { recursive: true });
      fs.mkdirSync(projectDir, { recursive: true });
      const capturedContexts: IntegrationContext[] = [];

      const state = makeState();
      state.integrations.installed.push({
        id: 'integration-id',
        integrationId: 'test-integration',
        installedByCliVersion: '0.9.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        updatedByCliVersion: '0.9.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
        features: [
          recordedCoexistingFeature('container-feature', 'global', globalDir, undefined, [
            { featureId: 'sub-a', dependencies: [] },
          ]),
          recordedCoexistingFeature(
            'container-feature',
            'project',
            projectDir,
            { projectKey: 'proj' },
            [
              { featureId: 'sub-a', dependencies: [] },
              { featureId: 'project-only-sub', dependencies: [] },
            ],
          ),
        ],
      });

      const container: FeatureContainer = {
        id: 'container-feature',
        displayName: 'Container feature',
        subfeatures: [
          { id: 'sub-a', displayName: 'Sub A' },
          { id: 'project-only-sub', displayName: 'Project-only sub', scope: 'project' },
        ],
        defaultInstallSubfeatureIds: [],
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

      expect(state.integrations.installed[0].features).toHaveLength(1);
      const collapsedFeature = state.integrations.installed[0].features[0];
      expect(collapsedFeature.scope).toBe('global');
      expect((collapsedFeature.subfeatures ?? []).map((s) => s.featureId)).toEqual(['sub-a']);

      const lastContext = capturedContexts[
        capturedContexts.length - 1
      ] as ContainerIntegrationContext;
      expect(lastContext.activeSubfeatures.map((s) => s.id)).toEqual(['sub-a']);
    });
  });
});

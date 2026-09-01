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

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type {
  FeatureDeclaration,
  IntegrationContext,
  IntegrationDeclaration,
} from '@/core/framework/features';
import {
  type CliState,
  getDefaultState,
  type InstalledIntegrationFeature,
} from '@/core/state/state.ts';

const binaryInstall = await import('@/core/host/install/binary.ts');
await mock.module('@/core/host/install/binary.ts', () => ({
  ...binaryInstall,
}));

const {
  findInstalledFeature,
  IntegrationInstaller,
  jsonPatch,
  textSnippetRemover,
  sonarSourceBinary,
  textSnippet,
  wholeFile,
} = await import('@/core/framework/features');
const { SECRETS_SPEC } = await import('@/core/host/install/secrets.ts');
const { removeInstalledFeature } =
  await import('@/core/framework/features/installation-recorder.ts');

type Installer = InstanceType<typeof IntegrationInstaller>;

describe('declarative integration framework - resources and state recording', () => {
  const installer = new IntegrationInstaller();
  let tempDir: string;
  let installBinarySpy: ReturnType<typeof spyOn>;
  let resolveBinaryPathSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-cli-framework-'));
    installBinarySpy = spyOn(binaryInstall, 'installBinary').mockResolvedValue({
      binaryPath: join(tempDir, 'bin', 'sonar-secrets'),
      freshlyInstalled: true,
    });
    resolveBinaryPathSpy = spyOn(binaryInstall, 'resolveBinaryPath').mockReturnValue(null);
  });

  afterEach(() => {
    installBinarySpy.mockRestore();
    resolveBinaryPathSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('updates text snippets in existing files and escapes marker characters', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    const targetPath = join(tempDir, 'existing.txt');
    await writeFile(
      targetPath,
      [
        'before',
        '# sonar:begin [feature]',
        'old content',
        '# sonar:end [feature]',
        'after',
        '',
      ].join('\n'),
    );
    const resource = textSnippet({
      id: 'feature',
      targetPath,
      content: 'new content',
      startMarker: '# sonar:begin [feature]',
      endMarker: '# sonar:end [feature]',
    });

    await resource.apply(context);

    expect(await readFile(targetPath, 'utf-8')).toBe(
      [
        'before',
        '# sonar:begin [feature]',
        'new content',
        '# sonar:end [feature]',
        'after',
        '',
      ].join('\n'),
    );
    expect(await resource.isApplied(context)).toBe(true);
  });

  it('appends text snippets to non-empty files and reports missing snippets as not applied', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    const targetPath = join(tempDir, 'append.txt');
    const resource = textSnippet({
      id: 'append',
      targetPath,
      content: 'managed content',
      startMarker: '# sonar:begin append',
    });

    expect(await resource.isApplied(context)).toBe(false);

    await writeFile(targetPath, 'existing content\n');
    await resource.apply(context);

    expect(await readFile(targetPath, 'utf-8')).toBe(
      [
        'existing content',
        '',
        '# sonar:begin append',
        'managed content',
        '# sonar:end append',
        '',
      ].join('\n'),
    );
  });

  it('replaces legacy text snippets that only contain the start marker', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    const targetPath = join(tempDir, 'legacy.txt');
    await writeFile(
      targetPath,
      [
        '#!/bin/sh',
        '# sonar:begin append',
        'old managed content',
        '"$SONAR_BIN" hook git-pre-commit',
        '',
      ].join('\n'),
    );
    const resource = textSnippet({
      id: 'append',
      targetPath,
      content: 'managed content',
      startMarker: '# sonar:begin append',
    });

    await resource.apply(context);

    expect(await readFile(targetPath, 'utf-8')).toBe(
      ['#!/bin/sh', '# sonar:begin append', 'managed content', '# sonar:end append', ''].join('\n'),
    );
  });

  it('textSnippetRemover removes an old block; current textSnippet then writes the new block', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    const targetPath = join(tempDir, 'legacy-block.txt');
    await writeFile(
      targetPath,
      ['#!/bin/sh', '# legacy marker', 'old managed content', '# sonar:end block', ''].join('\n'),
    );
    const legacy = textSnippetRemover({
      id: 'block',
      version: '0',
      targetPath,
      startMarker: '# legacy marker',
      endMarker: '# sonar:end block',
    });
    const resource = textSnippet({
      id: 'block',
      targetPath,
      content: 'managed content',
      startMarker: '# sonar:begin block',
      endMarker: '# sonar:end block',
    });

    // isApplied is false while only the legacy block is present.
    expect(await resource.isApplied(context)).toBe(false);

    // Cleanup step: remove the legacy block first.
    await legacy.remove(context);
    const afterCleanup = await readFile(targetPath, 'utf-8');
    expect(afterCleanup).not.toContain('# legacy marker');
    expect(afterCleanup).not.toContain('old managed content');

    // Apply step: write the current block.
    await resource.apply(context);
    const migrated = await readFile(targetPath, 'utf-8');
    expect(migrated.split('# sonar:begin block').length - 1).toBe(1);
    expect(migrated).toContain('managed content');
    expect(await resource.isApplied(context)).toBe(true);

    // Remove step: current resource cleans up its own block.
    await resource.remove?.(context);
    const removed = await readFile(targetPath, 'utf-8');
    expect(removed).not.toContain('# sonar:begin block');
  });

  it('skips operations when shouldApply returns false', async () => {
    const state = getDefaultState('test');
    let called = false;
    const feature: FeatureDeclaration = {
      id: 'feature',
      displayName: 'Feature',
      operations: [
        {
          id: 'operation',
          shouldApply: () => false,
          apply: () => {
            called = true;
          },
        },
      ],
    };
    const integration = makeIntegration({ features: [feature] });

    const installed = await applyAndRecord(
      installer,
      makeContext(state, tempDir),
      integration,
      feature,
    );

    expect(called).toBe(false);
    expect(installed.operations).toEqual([]);
  });

  it('passes update execution mode to feature operations', async () => {
    const state = getDefaultState('test');
    let called = false;
    const feature: FeatureDeclaration = {
      id: 'feature',
      displayName: 'Feature',
      operations: [
        {
          id: 'operation',
          shouldApply: (context) => context.executionMode === 'install',
          apply: () => {
            called = true;
          },
        },
      ],
    };
    const integration = makeIntegration({ features: [feature] });

    const installed = await installer.applyAndRecordFeatures(
      state,
      integration,
      [{ feature, targetRoot: tempDir, scope: 'project' }],
      { executionMode: 'update' },
    );

    expect(called).toBe(false);
    expect(installed[0]?.operations).toEqual([]);
  });

  it('records multiple features under one installed integration', async () => {
    const state = getDefaultState('test');
    const firstFeature: FeatureDeclaration = {
      id: 'first',
      displayName: 'First',
      operations: [{ id: 'first-operation', apply: () => undefined }],
    };
    const secondFeature: FeatureDeclaration = {
      id: 'second',
      displayName: 'Second',
      operations: [{ id: 'second-operation', apply: () => undefined }],
    };
    const integration = makeIntegration({ features: [firstFeature, secondFeature] });
    const context = makeContext(state, tempDir);

    await applyAndRecord(installer, context, integration, firstFeature);
    await applyAndRecord(installer, context, integration, secondFeature);

    expect(state.integrations.installed).toHaveLength(1);
    expect(state.integrations.installed[0].integrationId).toBe('test-integration');
    expect(state.integrations.installed[0].features.map((feature) => feature.featureId)).toEqual([
      'first',
      'second',
    ]);
  });

  it('records the same feature for different targets under one installed integration', async () => {
    const state = getDefaultState('test');
    const feature: FeatureDeclaration = {
      id: 'feature',
      displayName: 'Feature',
      operations: [{ id: 'operation', apply: () => undefined }],
    };
    const integration = makeIntegration({ features: [feature] });

    await applyAndRecord(
      installer,
      makeContext(state, join(tempDir, 'project')),
      integration,
      feature,
    );
    await applyAndRecord(
      installer,
      makeContext(state, join(tempDir, 'global')),
      integration,
      feature,
    );

    expect(state.integrations.installed).toHaveLength(1);
    expect(state.integrations.installed[0].features).toHaveLength(2);
    expect(
      state.integrations.installed[0].features.map((entry) => entry.targetRoot).sort(),
    ).toEqual([join(tempDir, 'global'), join(tempDir, 'project')]);
  });

  it('prunes stale feature state when declarations change from operations to resources', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    const legacyFeature: FeatureDeclaration = {
      id: 'feature',
      displayName: 'Feature',
      operations: [{ id: 'legacy-operation', apply: () => undefined }],
    };
    const currentFeature: FeatureDeclaration = {
      id: 'feature',
      displayName: 'Feature',
      resources: [
        jsonPatch({
          id: 'json',
          targetPath: join(tempDir, 'settings.json'),
          patch: () => ({ enabled: true }),
          removePatch: (document) => document,
        }),
      ],
    };

    await applyAndRecord(
      installer,
      context,
      makeIntegration({ features: [legacyFeature] }),
      legacyFeature,
    );
    const installed = await applyAndRecord(
      installer,
      context,
      makeIntegration({ features: [currentFeature] }),
      currentFeature,
    );

    expect(installed.operations).toEqual([]);
    expect(installed.resources).toMatchObject([
      {
        id: 'json',
        resourceType: 'json-patch',
        path: join(tempDir, 'settings.json'),
      },
    ]);
  });

  it('keeps shared dependency state when no installed feature references it', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    recordDependency(state, 'binary', join(tempDir, 'bin', 'sonar-secrets'));
    const legacyFeature: FeatureDeclaration = {
      id: 'feature',
      displayName: 'Feature',
      dependencies: [
        sonarSourceBinary({
          id: 'binary',
          spec: SECRETS_SPEC,
        }),
      ],
    };
    const currentFeature: FeatureDeclaration = {
      id: 'feature',
      displayName: 'Feature',
      resources: [
        wholeFile({
          id: 'current',
          targetPath: join(tempDir, 'current.txt'),
          content: 'current',
        }),
      ],
    };

    await applyAndRecord(
      installer,
      context,
      makeIntegration({ features: [legacyFeature] }),
      legacyFeature,
    );
    const installed = await applyAndRecord(
      installer,
      context,
      makeIntegration({ features: [currentFeature] }),
      currentFeature,
    );

    expect(installed.dependencies).toEqual([]);
    expect(state.dependencies.installed.map((dependency) => dependency.id)).toEqual(['binary']);
  });

  it('checks SonarSource binary dependencies by their descriptor', async () => {
    const state = getDefaultState('test');
    const binaryPath = join(tempDir, 'bin', 'sonar-secrets');
    const dependency = sonarSourceBinary({
      id: 'binary',
      spec: SECRETS_SPEC,
    });
    const context = makeContext(state, tempDir);

    expect(await dependency.isInstalled(context)).toBe(false);

    resolveBinaryPathSpy.mockReturnValue(binaryPath);

    expect(await dependency.isInstalled(context)).toBe(true);

    const applied = await dependency.installOrUpdate(context);

    expect(installBinarySpy).toHaveBeenCalledWith(SECRETS_SPEC, {
      console: expect.anything(),
    });
    expect(applied).toEqual({
      id: 'binary',
      version: SECRETS_SPEC.version,
      path: binaryPath,
    });
  });

  it('reports whether dependencies, resources, and operations need to be applied', async () => {
    const state = getDefaultState('test');
    const feature: FeatureDeclaration = {
      id: 'feature',
      displayName: 'Feature',
      dependencies: [
        sonarSourceBinary({
          id: 'dependency',
          version: '1',
          spec: SECRETS_SPEC,
        }),
      ],
      resources: [
        wholeFile({
          id: 'resource',
          version: '1',
          targetPath: join(tempDir, 'file.txt'),
          content: 'content',
        }),
      ],
      operations: [{ id: 'operation', version: '1', apply: () => undefined }],
    };
    const integration = makeIntegration({ features: [feature] });
    const context = makeContext(state, tempDir);

    expect(await installer.dependencyNeedsInstall(context, feature.dependencies![0])).toBe(true);
    expect(await installer.resourceNeedsApply(context, undefined, feature.resources![0])).toBe(
      true,
    );
    expect(installer.operationNeedsApply(undefined, feature.operations![0])).toBe(true);
    expect(
      installer.operationNeedsApply(undefined, { id: 'unversioned', apply: () => undefined }),
    ).toBe(true);

    const installed = await applyAndRecord(installer, context, integration, feature);
    const found = findInstalledFeature(state, context, integration, feature);
    recordDependency(state, 'dependency', join(tempDir, 'bin', 'sonar-secrets'), '1');
    resolveBinaryPathSpy.mockReturnValue(join(tempDir, 'bin', 'sonar-secrets'));

    expect(found?.featureId).toBe(installed.featureId);
    expect(await installer.dependencyNeedsInstall(context, feature.dependencies![0])).toBe(false);
    expect(await installer.resourceNeedsApply(context, installed, feature.resources![0])).toBe(
      false,
    );
    expect(installer.operationNeedsApply(installed, feature.operations![0])).toBe(false);
    expect(
      await installer.dependencyNeedsInstall(
        context,
        sonarSourceBinary({
          id: 'dependency',
          version: '2',
          spec: SECRETS_SPEC,
        }),
      ),
    ).toBe(true);
    expect(
      await installer.resourceNeedsApply(
        context,
        installed,
        wholeFile({
          id: 'resource',
          version: '2',
          targetPath: join(tempDir, 'file.txt'),
          content: 'content',
        }),
      ),
    ).toBe(true);
    expect(
      await installer.resourceNeedsApply(
        context,
        installed,
        wholeFile({
          id: 'resource',
          version: '1',
          targetPath: join(tempDir, 'file.txt'),
          content: 'updated content',
        }),
      ),
    ).toBe(true);
    expect(
      installer.operationNeedsApply(installed, { ...feature.operations![0], version: '2' }),
    ).toBe(true);
  });

  it('removeInstalledFeature does not mutate state when the integration is not recorded', () => {
    const integration = makeIntegration();
    const state = getDefaultState('test');

    removeInstalledFeature(
      state,
      { scope: 'project', targetRoot: tempDir },
      integration,
      integration.features[0],
    );

    expect(state.integrations.installed).toEqual([]);
  });

  it('removeInstalledFeature leaves other features intact when the target feature is not recorded', async () => {
    const integration = makeIntegration();
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    // Record a different feature; the one we ask to remove was never installed.
    await applyAndRecord(installer, context, integration, { id: 'other', displayName: 'Other' });

    removeInstalledFeature(state, context, integration, integration.features[0]);

    expect(state.integrations.installed[0]?.features.map((f) => f.featureId)).toEqual(['other']);
  });
});

function makeIntegration<TOptions = Record<string, unknown>>(
  overrides: Partial<IntegrationDeclaration<TOptions>> = {},
): IntegrationDeclaration<TOptions> {
  return {
    id: 'test-integration',
    displayName: 'Test Integration',
    features: [{ id: 'feature', displayName: 'Feature' }],
    ...overrides,
  };
}

function makeContext(
  state: ReturnType<typeof getDefaultState>,
  targetRoot: string,
  attrs?: IntegrationContext['attrs'],
  force?: boolean,
  executionMode: IntegrationContext['executionMode'] = 'install',
): IntegrationContext {
  return {
    state,
    targetRoot,
    scope: 'project',
    executionMode,
    force,
    attrs,
    resolvedDependencies: new Map(),
  };
}

/** Stands in for `recordInstalledDependency`, the binary installer's own state write. */
function recordDependency(
  state: CliState,
  id: string,
  path: string,
  version = SECRETS_SPEC.version,
): void {
  state.dependencies.installed.push({
    id,
    version,
    path,
    updatedAt: new Date().toISOString(),
    updatedByCliVersion: 'test',
  });
}

async function applyAndRecord<TOptions>(
  installer: Installer,
  context: IntegrationContext,
  integration: IntegrationDeclaration<TOptions>,
  feature: FeatureDeclaration<TOptions>,
): Promise<InstalledIntegrationFeature> {
  const installed = await installer.applyAndRecordFeatures(context.state, integration, [
    {
      feature,
      targetRoot: context.targetRoot,
      scope: context.scope,
      force: context.force,
      attrs: context.attrs,
    },
  ]);
  if (installed.length === 0) {
    throw new Error('Feature was not recorded');
  }
  return installed[0];
}

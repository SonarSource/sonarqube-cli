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
} from '../../../../../../src/cli/commands/integrate/_common/registry';
import { getDefaultState } from '../../../../../../src/lib/state';
import {
  clearMockUiCalls,
  getMockUiCalls,
  queueMockResponse,
  setMockUi,
} from '../../../../../../src/ui';

const binaryInstall = await import('../../../../../../src/cli/commands/_common/install/binary');
void mock.module('../../../../../../src/cli/commands/_common/install/binary', () => ({
  ...binaryInstall,
}));

const {
  createIntegrationRegistry,
  IntegrationInstaller,
  IntegrationRegistry,
  jsonPatch,
  SonarSourceBinary,
  sonarSourceBinary,
  textSnippet,
  tomlPatch,
  wholeFile,
  yamlPatch,
} = await import('../../../../../../src/cli/commands/integrate/_common/registry');

describe('declarative integration framework', () => {
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
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    setMockUi(false);
    installBinarySpy.mockRestore();
    resolveBinaryPathSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects duplicate integration registrations', () => {
    const registry = new IntegrationRegistry();
    const declaration = makeIntegration();

    registry.register(declaration);

    expect(() => registry.register(declaration)).toThrow(
      'Integration declaration already registered: test-integration',
    );
  });

  it('rejects duplicate integration ids when seeding a registry from static data', () => {
    expect(() => createIntegrationRegistry([makeIntegration(), makeIntegration()])).toThrow(
      'Integration declaration already registered: test-integration',
    );
  });

  it('rejects duplicate feature, dependency, resource, and operation ids', () => {
    const registry = new IntegrationRegistry();

    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            { id: 'same', displayName: 'One' },
            { id: 'same', displayName: 'Two' },
          ],
        }),
      ),
    ).toThrow('Duplicate feature id in integration test-integration');

    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            {
              id: 'feature',
              displayName: 'Feature',
              dependencies: [
                sonarSourceBinary({ id: 'same', binary: SonarSourceBinary.SonarSecrets }),
                sonarSourceBinary({ id: 'same', binary: SonarSourceBinary.SonarSecrets }),
              ],
            },
          ],
        }),
      ),
    ).toThrow('Duplicate dependency id in feature test-integration.feature');

    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            {
              id: 'feature',
              displayName: 'Feature',
              resources: [
                wholeFile({ id: 'same', targetPath: '/tmp/a', content: 'a' }),
                wholeFile({ id: 'same', targetPath: '/tmp/b', content: 'b' }),
              ],
            },
          ],
        }),
      ),
    ).toThrow('Duplicate resource id in feature test-integration.feature');

    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            {
              id: 'feature',
              displayName: 'Feature',
              operations: [
                { id: 'same', apply: () => undefined },
                { id: 'same', apply: () => undefined },
              ],
            },
          ],
        }),
      ),
    ).toThrow('Duplicate operation id in feature test-integration.feature');

    expect(() =>
      registry.register(
        makeIntegration({
          legacyFeatures: [
            { id: 'legacy', removable: true },
            { id: 'legacy', removable: false },
          ],
        }),
      ),
    ).toThrow('Duplicate legacy feature id in integration test-integration');
  });

  it('rejects empty declaration ids', () => {
    const registry = new IntegrationRegistry();

    expect(() => registry.register(makeIntegration({ id: ' ' }))).toThrow(
      'Integration id must not be empty',
    );
    expect(() =>
      registry.register(
        makeIntegration({
          features: [{ id: ' ', displayName: 'Feature' }],
        }),
      ),
    ).toThrow('Feature id must not be empty');
    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            {
              id: 'feature',
              displayName: 'Feature',
              dependencies: [
                sonarSourceBinary({ id: ' ', binary: SonarSourceBinary.SonarSecrets }),
              ],
            },
          ],
        }),
      ),
    ).toThrow('Dependency id must not be empty');
    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            {
              id: 'feature',
              displayName: 'Feature',
              resources: [wholeFile({ id: ' ', targetPath: '/tmp/file', content: '' })],
            },
          ],
        }),
      ),
    ).toThrow('Resource id must not be empty');
    expect(() =>
      registry.register(
        makeIntegration({
          features: [
            {
              id: 'feature',
              displayName: 'Feature',
              operations: [{ id: ' ', apply: () => undefined }],
            },
          ],
        }),
      ),
    ).toThrow('Operation id must not be empty');
    expect(() =>
      registry.register(
        makeIntegration({
          legacyFeatures: [{ id: ' ', removable: true }],
        }),
      ),
    ).toThrow('Legacy feature id must not be empty');
  });

  it('lists registered integrations', () => {
    const registry = new IntegrationRegistry();
    const first = makeIntegration({ id: 'first' });
    const second = makeIntegration({ id: 'second' });

    registry.register(first);
    registry.register(second);

    expect(registry.get('first')).toBe(first);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.list()).toEqual([first, second]);
  });

  it('selects declared features and rejects unknown feature ids', () => {
    const integration = makeIntegration({
      features: [
        { id: 'one', displayName: 'One' },
        { id: 'two', displayName: 'Two' },
      ],
    });

    expect(
      installer.selectFeatures(integration, ['two', 'one']).map((feature) => feature.id),
    ).toEqual(['two', 'one']);
    expect(() => installer.selectFeatures(integration, ['missing'])).toThrow(
      'Unknown feature test-integration.missing',
    );
  });

  it('selects features matching an invocation', async () => {
    interface GitOptions {
      nonInteractive?: boolean;
    }
    const integration: IntegrationDeclaration<GitOptions> = makeIntegration({
      features: [
        {
          id: 'pre-commit',
          displayName: 'Pre-commit',
        },
        {
          id: 'pre-push',
          displayName: 'Pre-push',
          when: ({ options }) =>
            options.nonInteractive === true ? { kind: 'skip' } : { kind: 'ask' },
        },
      ],
    });

    expect(
      (
        await installer.selectFeaturesForInvocation(integration, {
          options: { nonInteractive: true },
          targetRoot: tempDir,
          scope: 'project',
          nonInteractive: true,
        })
      ).map((feature) => feature.id),
    ).toEqual(['pre-commit']);

    queueMockResponse(true);
    queueMockResponse(true);
    expect(
      (
        await installer.selectFeaturesForInvocation(integration, {
          options: { nonInteractive: false },
          targetRoot: tempDir,
          scope: 'project',
          nonInteractive: false,
        })
      ).map((feature) => feature.id),
    ).toEqual(['pre-commit', 'pre-push']);
  });

  it('skips feature and shows reason when when() returns skip with reason', async () => {
    const integration: IntegrationDeclaration = makeIntegration<Record<string, unknown>>({
      features: [
        {
          id: 'f',
          displayName: 'My Feature',
          when: () => ({ kind: 'skip', reason: 'already done' }),
        },
      ],
    });

    const selected = await installer.selectFeaturesForInvocation(
      integration,
      makeInvocation(tempDir),
    );

    expect(selected).toHaveLength(0);
    expect(
      getMockUiCalls().some(
        (c) => c.method === 'info' && String(c.args[0]) === 'My Feature: already done',
      ),
    ).toBe(true);
  });

  it('skips feature silently when when() returns skip without reason', async () => {
    const integration: IntegrationDeclaration = makeIntegration<Record<string, unknown>>({
      features: [{ id: 'f', displayName: 'My Feature', when: () => ({ kind: 'skip' }) }],
    });

    const selected = await installer.selectFeaturesForInvocation(
      integration,
      makeInvocation(tempDir),
    );

    expect(selected).toHaveLength(0);
    expect(getMockUiCalls().some((c) => c.method === 'info')).toBe(false);
  });

  it('prompts with default question including hint when when() returns ask', async () => {
    const integration: IntegrationDeclaration = makeIntegration<Record<string, unknown>>({
      features: [
        { id: 'f', displayName: 'My Feature', hint: 'does X', when: () => ({ kind: 'ask' }) },
      ],
    });
    queueMockResponse(true);

    const selected = await installer.selectFeaturesForInvocation(
      integration,
      makeInvocation(tempDir),
    );

    expect(selected.map((f) => f.id)).toEqual(['f']);
    expect(
      getMockUiCalls().some(
        (c) => c.method === 'confirmPrompt' && String(c.args[0]) === 'Set up My Feature? (does X)',
      ),
    ).toBe(true);
  });

  it('prompts with default question when no hint is set', async () => {
    const integration: IntegrationDeclaration = makeIntegration<Record<string, unknown>>({
      features: [{ id: 'f', displayName: 'My Feature', when: () => ({ kind: 'ask' }) }],
    });
    queueMockResponse(true);

    await installer.selectFeaturesForInvocation(integration, makeInvocation(tempDir));

    expect(
      getMockUiCalls().some(
        (c) => c.method === 'confirmPrompt' && String(c.args[0]) === 'Set up My Feature?',
      ),
    ).toBe(true);
  });

  it('uses custom question when when() returns ask with question', async () => {
    const integration: IntegrationDeclaration = makeIntegration<Record<string, unknown>>({
      features: [
        {
          id: 'f',
          displayName: 'My Feature',
          when: () => ({ kind: 'ask', question: 'Enable this?' }),
        },
      ],
    });
    queueMockResponse(true);

    await installer.selectFeaturesForInvocation(integration, makeInvocation(tempDir));

    expect(
      getMockUiCalls().some(
        (c) => c.method === 'confirmPrompt' && String(c.args[0]) === 'Enable this?',
      ),
    ).toBe(true);
  });

  it('excludes feature when user declines the prompt', async () => {
    const integration: IntegrationDeclaration = makeIntegration<Record<string, unknown>>({
      features: [{ id: 'f', displayName: 'My Feature', when: () => ({ kind: 'ask' }) }],
    });
    queueMockResponse(false);

    const selected = await installer.selectFeaturesForInvocation(
      integration,
      makeInvocation(tempDir),
    );

    expect(selected).toHaveLength(0);
  });

  it('auto-accepts all ask features in nonInteractive mode without prompting', async () => {
    const integration: IntegrationDeclaration = makeIntegration<Record<string, unknown>>({
      features: [
        { id: 'a', displayName: 'A', when: () => ({ kind: 'ask' }) },
        { id: 'b', displayName: 'B' },
      ],
    });

    const selected = await installer.selectFeaturesForInvocation(
      integration,
      makeInvocation(tempDir, { nonInteractive: true }),
    );

    expect(selected.map((f) => f.id)).toEqual(['a', 'b']);
    expect(getMockUiCalls().some((c) => c.method === 'confirmPrompt')).toBe(false);
  });

  it('handles async when() callbacks', async () => {
    const integration: IntegrationDeclaration = makeIntegration<Record<string, unknown>>({
      features: [
        { id: 'f', displayName: 'My Feature', when: () => Promise.resolve({ kind: 'ask' }) },
      ],
    });

    const selected = await installer.selectFeaturesForInvocation(
      integration,
      makeInvocation(tempDir, { nonInteractive: true }),
    );

    expect(selected.map((f) => f.id)).toEqual(['f']);
  });

  it('includes feature when no when() is defined', async () => {
    const integration: IntegrationDeclaration = makeIntegration<Record<string, unknown>>({
      features: [{ id: 'f', displayName: 'My Feature' }],
    });

    const selected = await installer.selectFeaturesForInvocation(
      integration,
      makeInvocation(tempDir, { nonInteractive: true }),
    );

    expect(selected.map((f) => f.id)).toEqual(['f']);
  });

  it('applies declared resources and records the feature once', async () => {
    const state = getDefaultState('test');
    const operationCalls: string[] = [];
    const feature: FeatureDeclaration = {
      id: 'feature',
      displayName: 'Feature',
      dependencies: [
        sonarSourceBinary({
          id: 'binary',
          binary: SonarSourceBinary.SonarSecrets,
        }),
      ],
      resources: [
        wholeFile({
          id: 'whole',
          version: '1',
          targetPath: join(tempDir, 'script.sh'),
          content: '#!/bin/sh\necho sonar\n',
          executable: true,
        }),
        jsonPatch({
          id: 'json',
          targetPath: join(tempDir, 'settings.json'),
          patch: (document) => ({ ...(document as Record<string, unknown>), enabled: true }),
        }),
        yamlPatch({
          id: 'yaml',
          targetPath: join(tempDir, 'config.yml'),
          patch: () => ({ repos: [{ repo: 'local' }] }),
        }),
        tomlPatch({
          id: 'toml',
          targetPath: join(tempDir, 'config.toml'),
          patch: (document) => ({ ...document, enabled: true }),
        }),
        textSnippet({
          id: 'text',
          targetPath: join(tempDir, 'pre-commit-config.yaml'),
          content: 'repos: []',
          executable: true,
          startMarker: '# sonar:begin text',
        }),
      ],
      operations: [
        {
          id: 'operation',
          version: '1',
          apply: () => {
            operationCalls.push('operation');
          },
        },
      ],
    };
    const integration = makeIntegration({ features: [feature] });
    const context = makeContext(state, tempDir, { projectKey: 'project' });

    const first = await installer.applyAndRecordFeature(context, integration, feature);
    const second = await installer.applyAndRecordFeature(context, integration, feature);

    expect(first.featureId).toBe(second.featureId);
    expect(state.integrations.installed).toHaveLength(1);
    expect(state.integrations.installed[0].features).toHaveLength(1);
    expect(state.integrations.installed[0].features[0].attrs?.projectKey).toBe('project');
    expect(state.integrations.installed[0].features[0].targetRoot).toBe(tempDir);
    expect(second.dependencies).toEqual([{ id: 'binary' }]);
    expect(second.resources.map((resource) => resource.id).sort()).toEqual([
      'json',
      'text',
      'toml',
      'whole',
      'yaml',
    ]);
    expect(second.operations.map((operation) => operation.id)).toEqual(['operation']);
    expect(state.dependencies.installed).toMatchObject([
      {
        id: 'binary',
        dependencyType: 'sonarsource-binary',
        version: SonarSourceBinary.SonarSecrets.spec.version,
        path: join(tempDir, 'bin', 'sonar-secrets'),
      },
    ]);
    expect(operationCalls).toEqual(['operation', 'operation']);
    expect(await readFile(join(tempDir, 'script.sh'), 'utf-8')).toBe('#!/bin/sh\necho sonar\n');
    expect(JSON.parse(await readFile(join(tempDir, 'settings.json'), 'utf-8'))).toEqual({
      enabled: true,
    });
    expect(await readFile(join(tempDir, 'pre-commit-config.yaml'), 'utf-8')).toContain(
      '# sonar:begin text',
    );
  });

  it('supports whole-file static, dynamic, and platform-specific content', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir, { projectKey: 'project' });
    const staticResource = wholeFile({
      id: 'static',
      targetPath: join(tempDir, 'static.txt'),
      content: 'static content',
    });
    const dynamicResource = wholeFile({
      id: 'dynamic',
      targetPath: join(tempDir, 'dynamic.txt'),
      content: (currentContext) => `project=${currentContext.attrs?.projectKey}`,
    });
    const platformResource = wholeFile({
      id: 'platform',
      targetPath: join(tempDir, 'platform.txt'),
      content: {
        unix: 'unix content',
        windows: 'windows content',
      },
    });

    await staticResource.apply(context);
    await dynamicResource.apply(context);
    await platformResource.apply(context);

    expect(await readFile(join(tempDir, 'static.txt'), 'utf-8')).toBe('static content');
    expect(await readFile(join(tempDir, 'dynamic.txt'), 'utf-8')).toBe('project=project');
    expect(await readFile(join(tempDir, 'platform.txt'), 'utf-8')).toBe(
      process.platform === 'win32' ? 'windows content' : 'unix content',
    );
    expect(await staticResource.isApplied(context)).toBe(true);
    expect(await dynamicResource.isApplied(context)).toBe(true);
    expect(await platformResource.isApplied(context)).toBe(true);
  });

  it('requires force to overwrite protected whole files unless the file is already managed', async () => {
    const state = getDefaultState('test');
    const targetPath = join(tempDir, 'hook.sh');
    const resource = wholeFile({
      id: 'hook',
      displayName: 'pre-commit hook',
      targetPath,
      content: '#!/bin/sh\n# sonar-managed\necho sonar\n',
      executable: true,
      requiresForce: true,
      managedMarker: '# sonar-managed',
    });

    await writeFile(targetPath, '#!/bin/sh\necho user-defined\n');

    expect(resource.apply(makeContext(state, tempDir))).rejects.toThrow(
      `Refusing to overwrite existing pre-commit hook at ${targetPath}. Use --force to replace.`,
    );

    await resource.apply(makeContext(state, tempDir, undefined, true));
    expect(await readFile(targetPath, 'utf-8')).toBe('#!/bin/sh\n# sonar-managed\necho sonar\n');

    await writeFile(targetPath, '#!/bin/sh\n# sonar-managed\necho older sonar\n');
    await resource.apply(makeContext(state, tempDir));
    expect(await readFile(targetPath, 'utf-8')).toBe('#!/bin/sh\n# sonar-managed\necho sonar\n');
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

    const installed = await installer.applyAndRecordFeature(
      makeContext(state, tempDir),
      integration,
      feature,
    );

    expect(called).toBe(false);
    expect(installed.operations).toEqual([]);
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

    await installer.applyAndRecordFeature(context, integration, firstFeature);
    await installer.applyAndRecordFeature(context, integration, secondFeature);

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

    await installer.applyAndRecordFeature(
      makeContext(state, join(tempDir, 'project')),
      integration,
      feature,
    );
    await installer.applyAndRecordFeature(
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
        }),
      ],
    };

    await installer.applyAndRecordFeature(
      context,
      makeIntegration({ features: [legacyFeature] }),
      legacyFeature,
    );
    const installed = await installer.applyAndRecordFeature(
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

  it('prunes stale shared dependency state when no installed feature references it', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    const legacyFeature: FeatureDeclaration = {
      id: 'feature',
      displayName: 'Feature',
      dependencies: [
        sonarSourceBinary({
          id: 'binary',
          binary: SonarSourceBinary.SonarSecrets,
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

    await installer.applyAndRecordFeature(
      context,
      makeIntegration({ features: [legacyFeature] }),
      legacyFeature,
    );
    const installed = await installer.applyAndRecordFeature(
      context,
      makeIntegration({ features: [currentFeature] }),
      currentFeature,
    );

    expect(installed.dependencies).toEqual([]);
    expect(state.dependencies.installed).toEqual([]);
  });

  it('checks SonarSource binary dependencies by their descriptor', async () => {
    const state = getDefaultState('test');
    const binaryPath = join(tempDir, 'bin', 'sonar-secrets');
    const dependency = sonarSourceBinary({
      id: 'binary',
      binary: SonarSourceBinary.SonarSecrets,
    });
    const context = makeContext(state, tempDir);

    expect(await dependency.isInstalled(context)).toBe(false);

    resolveBinaryPathSpy.mockReturnValue(binaryPath);

    expect(await dependency.isInstalled(context)).toBe(true);

    const applied = await dependency.install(context);

    expect(installBinarySpy).toHaveBeenCalledWith(SonarSourceBinary.SonarSecrets.spec);
    expect(applied).toEqual({
      id: 'binary',
      dependencyType: 'sonarsource-binary',
      version: SonarSourceBinary.SonarSecrets.spec.version,
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
          binary: SonarSourceBinary.SonarSecrets,
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

    const installed = await installer.applyAndRecordFeature(context, integration, feature);
    const found = installer.findInstalledFeature(state, context, integration, feature);
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
          binary: SonarSourceBinary.SonarSecrets,
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

  it('fails when JSON files contain invalid content', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    const jsonPath = join(tempDir, 'settings.json');
    await writeFile(jsonPath, '{ invalid json');
    const jsonResource = jsonPatch({
      id: 'json-invalid',
      targetPath: jsonPath,
      defaultValue: { fallback: true },
      patch: (document) => ({ ...(document as Record<string, unknown>), enabled: true }),
    });

    expect(jsonResource.apply(context)).rejects.toThrow(
      `${jsonPath} contains invalid JSON. Please fix or delete it and re-run.`,
    );
    expect(jsonResource.isApplied(context)).rejects.toThrow(
      `${jsonPath} contains invalid JSON. Please fix or delete it and re-run.`,
    );
  });

  it('fails when TOML files contain invalid content', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    const tomlPath = join(tempDir, 'config.toml');
    await writeFile(tomlPath, '= not valid toml =');
    const tomlResource = tomlPatch({
      id: 'toml-invalid',
      targetPath: tomlPath,
      defaultValue: {},
      patch: (document) => document,
    });

    expect(tomlResource.apply(context)).rejects.toThrow(
      `${tomlPath} contains invalid TOML. Please fix or delete it and re-run.`,
    );
    expect(tomlResource.isApplied(context)).rejects.toThrow(
      `${tomlPath} contains invalid TOML. Please fix or delete it and re-run.`,
    );
  });

  it('uses defaults when YAML files contain invalid content', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    const yamlPath = join(tempDir, 'settings.yml');
    await writeFile(yamlPath, 'invalid: [yaml');
    const yamlResource = yamlPatch({
      id: 'yaml-invalid',
      targetPath: yamlPath,
      patch: (document) => ({ ...(document as Record<string, unknown>), enabled: true }),
    });

    await yamlResource.apply(context);

    expect(await readFile(yamlPath, 'utf-8')).toBe('enabled: true\n');
    expect(await yamlResource.isApplied(context)).toBe(true);
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
): IntegrationContext {
  return {
    state,
    targetRoot,
    scope: 'project',
    force,
    attrs,
  };
}

function makeInvocation(targetRoot: string, opts?: { nonInteractive?: boolean }) {
  return {
    options: {} as Record<string, unknown>,
    targetRoot,
    scope: 'project' as const,
    ...opts,
  };
}

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
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CommandFailedError } from '../../../../../../src/cli/commands/_common/error';
import {
  type DependencyDeclaration,
  type FeatureContainer,
  type FeatureDeclaration,
  installIntegration,
  type IntegrationDeclaration,
  IntegrationRegistry,
  wholeFile,
} from '../../../../../../src/cli/commands/integrate/_common/registry';
import * as stateRepository from '../../../../../../src/lib/repository/state-repository';
import { getDefaultState } from '../../../../../../src/lib/state';
import * as integrateTelemetry from '../../../../../../src/telemetry/integrate-telemetry';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../../src/ui';

describe('generic integration installer', () => {
  let tempDir: string;
  let registry: IntegrationRegistry;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let emitIntegrationConfiguredTelemetrySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-cli-installer-'));
    registry = new IntegrationRegistry();
    setMockUi(true);
    clearMockUiCalls();
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => undefined);
    emitIntegrationConfiguredTelemetrySpy = spyOn(
      integrateTelemetry,
      'emitIntegrationConfiguredTelemetry',
    ).mockImplementation(() => undefined);
  });

  afterEach(() => {
    setMockUi(false);
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    emitIntegrationConfiguredTelemetrySpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies selected resources and operations, records state, and emits generic messages', async () => {
    const state = getDefaultState('test');
    loadStateSpy.mockReturnValue(state);
    const operationCalls: string[] = [];
    const integration = registerIntegration(registry, 'installer-success', [
      {
        id: 'feature',
        displayName: 'Feature',
        resources: [
          wholeFile({
            id: 'file',
            displayName: 'Config file',
            targetPath: join(tempDir, 'config.txt'),
            content: 'enabled=true\n',
          }),
        ],
        operations: [
          {
            id: 'operation',
            displayName: 'Setup operation',
            apply: () => {
              operationCalls.push('called');
            },
          },
        ],
      },
    ]);

    const installed = await installIntegration({
      registry,
      integrationId: integration.id,
      options: {},
      targetRoot: tempDir,
      scope: 'project',
      attrs: { projectKey: 'project' },
    });

    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({
      featureId: 'feature',
      targetRoot: tempDir,
      attrs: { projectKey: 'project' },
    });
    expect(await readFile(join(tempDir, 'config.txt'), 'utf-8')).toBe('enabled=true\n');
    expect(operationCalls).toEqual(['called']);
    expect(saveStateSpy).toHaveBeenCalledWith(state);
    expect(hasUiCall('text', '     Installing Feature...')).toBe(true);
  });

  it('supports feature-specific target routing from a single installer invocation', async () => {
    const state = getDefaultState('test');
    loadStateSpy.mockReturnValue(state);
    const mainRoot = join(tempDir, 'global');
    const projectRoot = join(tempDir, 'project');
    const integration = registerIntegration<{
      installMain?: boolean;
      installProject?: boolean;
      projectRoot?: string;
    }>(registry, 'installer-feature-routing', [
      {
        id: 'main',
        displayName: 'Main feature',
        shouldInstall: ({ options }) => options.installMain === true,
        resources: [
          wholeFile({
            id: 'main-file',
            displayName: 'Main file',
            targetPath: (context) => join(context.targetRoot, 'main.txt'),
            content: 'main\n',
          }),
        ],
      },
      {
        id: 'project',
        displayName: 'Project feature',
        shouldInstall: ({ options }) => options.installProject === true,
        targetRoot: ({ options, targetRoot }) => options.projectRoot ?? targetRoot,
        scope: 'project',
        resources: [
          wholeFile({
            id: 'project-file',
            displayName: 'Project file',
            targetPath: (context) => join(context.targetRoot, 'project.txt'),
            content: 'project\n',
          }),
        ],
      },
    ]);

    const installed = await installIntegration({
      registry,
      integrationId: integration.id,
      options: {
        installMain: true,
        installProject: true,
        projectRoot,
      },
      targetRoot: mainRoot,
      scope: 'global',
    });

    expect(installed).toMatchObject([
      { featureId: 'main', targetRoot: mainRoot, scope: 'global' },
      { featureId: 'project', targetRoot: projectRoot, scope: 'project' },
    ]);
    expect(await readFile(join(mainRoot, 'main.txt'), 'utf-8')).toBe('main\n');
    expect(await readFile(join(projectRoot, 'project.txt'), 'utf-8')).toBe('project\n');
  });

  it('passes resolved dependency metadata to feature resources after dependency installation', async () => {
    const state = getDefaultState('test');
    loadStateSpy.mockReturnValue(state);
    const dependency: DependencyDeclaration = {
      id: 'shared-binary',
      dependencyType: 'binary',
      version: '2',
      installOrUpdate: () => ({
        id: 'shared-binary',
        dependencyType: 'binary',
        version: '2',
        path: '/opt/sonar/shared-binary',
      }),
      isInstalled: () => false,
      remove: () => {},
    };
    const integration = registerIntegration(registry, 'installer-resolved-dependency', [
      {
        id: 'feature',
        displayName: 'Feature',
        dependencies: [dependency],
        resources: [
          wholeFile({
            id: 'dependency-aware-file',
            displayName: 'Dependency-aware file',
            targetPath: join(tempDir, 'dependency.txt'),
            content: (context) => String(context.resolvedDependencies.get(dependency.id)?.path),
          }),
        ],
      },
    ]);

    await installIntegration({
      registry,
      integrationId: integration.id,
      options: {},
      targetRoot: tempDir,
      scope: 'project',
    });

    expect(await readFile(join(tempDir, 'dependency.txt'), 'utf-8')).toBe(
      '/opt/sonar/shared-binary',
    );
    expect(state.dependencies.installed).toMatchObject([
      {
        id: 'shared-binary',
        dependencyType: 'binary',
        version: '2',
        path: '/opt/sonar/shared-binary',
      },
    ]);
  });

  it('skips resources that are already applied and keeps their recorded metadata', async () => {
    const state = getDefaultState('test');
    loadStateSpy.mockReturnValue(state);
    const feature: FeatureDeclaration = {
      id: 'feature',
      displayName: 'Feature',
      resources: [
        wholeFile({
          id: 'file',
          displayName: 'Config file',
          targetPath: join(tempDir, 'config.txt'),
          content: 'enabled=true\n',
        }),
      ],
    };
    const integration = registerIntegration(registry, 'installer-skip-resource', [feature]);

    await installIntegration({
      registry,
      integrationId: integration.id,
      options: {},
      targetRoot: tempDir,
      scope: 'project',
    });
    clearMockUiCalls();

    const installed = await installIntegration({
      registry,
      integrationId: integration.id,
      options: {},
      targetRoot: tempDir,
      scope: 'project',
    });

    expect(installed[0].resources.some((resource) => resource.id === 'file')).toBe(true);
    expect(hasUiCall('text', '     Config file already installed')).toBe(true);
  });

  it('falls back to the resource id in the skip message when no displayName is set', async () => {
    const state = getDefaultState('test');
    loadStateSpy.mockReturnValue(state);
    const feature: FeatureDeclaration = {
      id: 'feature',
      displayName: 'Feature',
      resources: [
        wholeFile({
          id: 'unnamed-file',
          targetPath: join(tempDir, 'unnamed.txt'),
          content: 'enabled=true\n',
        }),
      ],
    };
    const integration = registerIntegration(registry, 'installer-skip-unnamed-resource', [feature]);

    await installIntegration({
      registry,
      integrationId: integration.id,
      options: {},
      targetRoot: tempDir,
      scope: 'project',
    });
    clearMockUiCalls();

    await installIntegration({
      registry,
      integrationId: integration.id,
      options: {},
      targetRoot: tempDir,
      scope: 'project',
    });

    expect(hasUiCall('text', '     unnamed-file already installed')).toBe(true);
  });

  it('falls back to the dependency id in the skip message when no displayName is set', async () => {
    const state = getDefaultState('test');
    loadStateSpy.mockReturnValue(state);
    const dependency: DependencyDeclaration = {
      id: 'unnamed-binary',
      dependencyType: 'binary',
      version: '1',
      installOrUpdate: () => ({
        id: 'unnamed-binary',
        dependencyType: 'binary',
        version: '1',
        path: '/opt/sonar/unnamed-binary',
      }),
      isInstalled: () => true,
      remove: () => {},
    };
    const integration = registerIntegration(registry, 'installer-skip-unnamed-dependency', [
      {
        id: 'feature',
        displayName: 'Feature',
        dependencies: [dependency],
        operations: [{ id: 'noop', apply: () => undefined }],
      },
    ]);

    await installIntegration({
      registry,
      integrationId: integration.id,
      options: {},
      targetRoot: tempDir,
      scope: 'project',
    });
    clearMockUiCalls();

    await installIntegration({
      registry,
      integrationId: integration.id,
      options: {},
      targetRoot: tempDir,
      scope: 'project',
    });

    expect(hasUiCall('text', '     unnamed-binary already installed')).toBe(true);
  });

  it('does not run operations when shouldApply returns false', async () => {
    let called = false;
    const integration = registerIntegration(registry, 'installer-should-apply', [
      {
        id: 'feature',
        displayName: 'Feature',
        operations: [
          {
            id: 'operation',
            displayName: 'Skipped operation',
            shouldApply: () => false,
            apply: () => {
              called = true;
            },
          },
        ],
      },
    ]);

    const installed = await installIntegration({
      registry,
      integrationId: integration.id,
      options: {},
      targetRoot: tempDir,
      scope: 'project',
    });

    expect(called).toBe(false);
    expect(installed[0].operations).toEqual([]);
    expect(getMockUiCalls().some((call) => call.args[0] === 'Applied Skipped operation')).toBe(
      false,
    );
  });

  it('passes install execution mode through installIntegration', async () => {
    let seenExecutionMode: string | undefined;
    let seenAuthToken: string | undefined;
    const integration = registerIntegration(registry, 'installer-execution-mode', [
      {
        id: 'feature',
        displayName: 'Feature',
        operations: [
          {
            id: 'operation',
            shouldApply: (context) => {
              seenExecutionMode = context.executionMode;
              return true;
            },
            apply: (context) => {
              seenAuthToken = context.auth?.token;
            },
          },
        ],
      },
    ]);

    await installIntegration({
      registry,
      integrationId: integration.id,
      options: {},
      targetRoot: tempDir,
      scope: 'project',
      auth: {
        token: 'test-token',
        serverUrl: 'https://sonarcloud.io',
        connectionType: 'cloud',
        orgKey: 'test-org',
      },
    });

    expect(seenExecutionMode).toBe('install');
    expect(seenAuthToken).toBe('test-token');
  });

  it('throws when the integration is unknown or no feature matches the invocation', async () => {
    const missingError = await catchError(() =>
      installIntegration({
        registry,
        integrationId: 'missing-integration',
        options: {},
        targetRoot: tempDir,
        scope: 'project',
      }),
    );

    expect(missingError?.message).toBe(
      'Integration declaration is not registered: missing-integration',
    );

    const integration = registerIntegration<{ enabled?: boolean }>(
      registry,
      'installer-no-feature',
      [
        {
          id: 'feature',
          displayName: 'Feature',
          shouldInstall: ({ options }) => options.enabled === true,
        },
      ],
    );

    const noFeatureError = await catchError(() =>
      installIntegration({
        registry,
        integrationId: integration.id,
        options: {},
        targetRoot: tempDir,
        scope: 'project',
      }),
    );

    expect(noFeatureError).toBeInstanceOf(CommandFailedError);
    expect(noFeatureError?.message).toBe('No feature selected for Test Integration');
  });

  it('passes force through the integration context for protected whole files', async () => {
    const targetPath = join(tempDir, 'hook.sh');
    await Bun.write(targetPath, '#!/bin/sh\necho user-defined\n');
    const integration = registerIntegration(registry, 'installer-force', [
      {
        id: 'feature',
        displayName: 'Feature',
        resources: [
          wholeFile({
            id: 'hook',
            displayName: 'pre-commit hook',
            targetPath,
            content: '#!/bin/sh\n# sonar-managed\necho sonar\n',
            executable: true,
            requiresForce: true,
            managedMarker: '# sonar-managed',
          }),
        ],
      },
    ]);

    let forceError: unknown;
    try {
      await installIntegration({
        registry,
        integrationId: integration.id,
        options: {},
        targetRoot: tempDir,
        scope: 'project',
      });
    } catch (error) {
      forceError = error;
    }
    if (!(forceError instanceof Error)) {
      throw new Error('Expected installIntegration to reject without --force');
    }
    expect(forceError.message).toContain(
      `A different pre-commit hook already exists at ${targetPath}`,
    );

    await installIntegration({
      registry,
      integrationId: integration.id,
      options: {},
      targetRoot: tempDir,
      scope: 'project',
      force: true,
    });

    expect(await readFile(targetPath, 'utf-8')).toBe('#!/bin/sh\n# sonar-managed\necho sonar\n');
  });

  it('saves features that succeeded before a later feature throws', async () => {
    const state = getDefaultState('test');
    loadStateSpy.mockReturnValue(state);
    const firstPath = join(tempDir, 'first.txt');
    const integration = registerIntegration(registry, 'installer-partial-save', [
      {
        id: 'first',
        displayName: 'First feature',
        resources: [
          wholeFile({
            id: 'first-file',
            displayName: 'First file',
            targetPath: firstPath,
            content: 'first\n',
          }),
        ],
      },
      {
        id: 'second',
        displayName: 'Second feature',
        operations: [
          {
            id: 'failing-operation',
            apply: () => {
              throw new Error('boom');
            },
          },
        ],
      },
    ]);

    let thrown: unknown;
    try {
      await installIntegration({
        registry,
        integrationId: integration.id,
        options: {},
        targetRoot: tempDir,
        scope: 'project',
      });
    } catch (error) {
      thrown = error;
    }
    if (!(thrown instanceof Error)) {
      throw new Error('Expected installIntegration to reject');
    }
    expect(thrown.message).toBe('boom');

    expect(await readFile(firstPath, 'utf-8')).toBe('first\n');
    expect(saveStateSpy).toHaveBeenCalledWith(state);
    expect(state.integrations.installed).toMatchObject([
      {
        integrationId: integration.id,
        features: [{ featureId: 'first' }],
      },
    ]);
  });

  it('prints container display name then each active subfeature on a separate indented line', async () => {
    const container: FeatureContainer = {
      id: 'container',
      displayName: 'Container Feature',
      defaultInstallSubfeatureIds: ['subfeature-1', 'subfeature-2'],
      subfeatures: [
        { id: 'subfeature-1', displayName: 'Subfeature One' },
        { id: 'subfeature-2', displayName: 'Subfeature Two' },
      ],
      resources: [
        wholeFile({
          id: 'container-file',
          displayName: 'Container file',
          targetPath: join(tempDir, 'container.txt'),
          content: 'enabled=true\n',
        }),
      ],
    };
    const integration = registerIntegration(registry, 'installer-container-messages', [container]);

    await installIntegration({
      registry,
      integrationId: integration.id,
      options: {},
      targetRoot: tempDir,
      scope: 'project',
    });

    expect(hasUiCall('text', '     Installing Container Feature...')).toBe(true);
    expect(hasUiCall('text', '       - Subfeature One')).toBe(true);
    expect(hasUiCall('text', '       - Subfeature Two')).toBe(true);
  });

  it('only lists active subfeatures when some are filtered out by shouldInstall', async () => {
    const container: FeatureContainer<{ enableOptional?: boolean }> = {
      id: 'container',
      displayName: 'Container Feature',
      defaultInstallSubfeatureIds: ['subfeature-1'],
      subfeatures: [
        { id: 'subfeature-1', displayName: 'Subfeature One' },
        {
          id: 'subfeature-2',
          displayName: 'Subfeature Two',
          shouldInstall: ({ options }) => options.enableOptional === true,
        },
      ],
      resources: [
        wholeFile({
          id: 'container-file',
          displayName: 'Container file',
          targetPath: join(tempDir, 'container.txt'),
          content: 'enabled=true\n',
        }),
      ],
    };
    const integration = registerIntegration<{ enableOptional?: boolean }>(
      registry,
      'installer-container-filtered-subfeatures',
      [container],
    );

    await installIntegration({
      registry,
      integrationId: integration.id,
      options: {},
      targetRoot: tempDir,
      scope: 'project',
    });

    expect(hasUiCall('text', '     Installing Container Feature...')).toBe(true);
    expect(hasUiCall('text', '       - Subfeature One')).toBe(true);
    expect(hasUiCall('text', '       - Subfeature Two')).toBe(false);
  });

  it('warns and continues when reading or writing state fails', async () => {
    const state = getDefaultState('test');
    loadStateSpy.mockImplementationOnce(() => {
      throw new Error('read failed');
    });
    loadStateSpy.mockReturnValue(state);
    saveStateSpy.mockImplementation(() => {
      throw new Error('write failed');
    });
    const integration = registerIntegration(registry, 'installer-state-failures', [
      {
        id: 'feature',
        displayName: 'Feature',
        operations: [{ id: 'operation', apply: () => undefined }],
      },
    ]);

    const installed = await installIntegration({
      registry,
      integrationId: integration.id,
      options: {},
      targetRoot: tempDir,
      scope: 'project',
    });

    expect(installed).toEqual([]);
    expect(hasUiCall('warn', 'Failed to read configuration state: read failed')).toBe(true);
    expect(hasUiCall('warn', 'Failed to update configuration state: write failed')).toBe(true);
  });
});

function hasUiCall(method: string, message: string): boolean {
  return getMockUiCalls().some((call) => call.method === method && call.args[0] === message);
}

async function catchError(fn: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function registerIntegration<TOptions = Record<string, unknown>>(
  registry: IntegrationRegistry,
  id: string,
  features: FeatureDeclaration<TOptions>[],
): IntegrationDeclaration<TOptions> {
  const integration: IntegrationDeclaration<TOptions> = {
    id,
    displayName: 'Test Integration',
    features,
  };
  registry.register(integration as IntegrationDeclaration);
  return integration;
}

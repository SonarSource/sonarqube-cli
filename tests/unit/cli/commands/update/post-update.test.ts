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

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';

import { version as CURRENT_VERSION } from '../../../../../package.json';
import * as scaScannerInstall from '../../../../../src/cli/commands/_common/install/sca-scanner';
import * as secretsInstall from '../../../../../src/cli/commands/_common/install/secrets';
import {
  type ContainerIntegrationContext,
  type DependencyDeclaration,
  type FeatureContainer,
  type IntegrationContext,
  IntegrationRegistry,
  wholeFile,
} from '../../../../../src/cli/commands/integrate/_common/registry';
import * as hooks from '../../../../../src/cli/commands/integrate/claude/hooks';
import * as configConstants from '../../../../../src/lib/config-constants';
import { DISTRIBUTION } from '../../../../../src/lib/distribution';
import { SCA_SCANNER_BINARY_NAME } from '../../../../../src/lib/install-types';
import * as migration from '../../../../../src/lib/migration';
import {
  migrateClaudeCodeHooks,
  migrateDeclarativeIntegrations,
  migrateLegacyTelemetryEvents,
  runPostUpdateActions,
  updateScaScannerBinaryIfNeeded,
  updateSecretsBinaryIfNeeded,
} from '../../../../../src/lib/post-update';
import * as stateRepository from '../../../../../src/lib/repository/state-repository';
import type {
  CliState,
  HookExtension,
  StoredCommandExecutedEvent,
} from '../../../../../src/lib/state';
import { getDefaultState } from '../../../../../src/lib/state';
import * as versionLib from '../../../../../src/lib/version';
import * as telemetryEvents from '../../../../../src/telemetry/telemetry-events';

const FAKE_HOME = '/fake/home';
const homedirFn = () => FAKE_HOME;

function makeState(): CliState {
  return getDefaultState('1.0.0');
}

function makeStateWithExtensions(extensions: HookExtension[], configured = true): CliState {
  const state = getDefaultState('1.0.0');
  state.agents['claude-code'].configured = configured;
  state.agentExtensions = extensions;
  return state;
}

function makeExtension(projectRoot: string, global: boolean): HookExtension {
  return {
    id: 'test-id',
    agentId: 'claude-code',
    kind: 'hook',
    name: 'sonar-secrets',
    hookType: 'PreToolUse',
    projectRoot,
    global,
    updatedByCliVersion: '1.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('runPostUpdateActions', () => {
  let existsSyncSpy: Mock<typeof fs.existsSync>;
  let stateFileExistsSpy: Mock<typeof stateRepository.stateFileExists>;
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let saveStateSpy: Mock<typeof stateRepository.saveState>;
  let isNewerVersionSpy: Mock<typeof versionLib.isNewerVersion>;
  let migrateHookScriptsSpy: Mock<typeof migration.migrateHookScripts>;
  let removeObsoleteHookArtifactsSpy: Mock<typeof migration.removeObsoleteHookArtifacts>;
  let installHooksSpy: Mock<typeof hooks.installHooks>;
  let installSecretsBinarySpy: Mock<typeof secretsInstall.installSecretsBinary>;

  beforeEach(() => {
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    stateFileExistsSpy = spyOn(stateRepository, 'stateFileExists').mockReturnValue(true);
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeState());
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => {});
    isNewerVersionSpy = spyOn(versionLib, 'isNewerVersion').mockReturnValue(true);
    migrateHookScriptsSpy = spyOn(migration, 'migrateHookScripts').mockImplementation(() => {});
    removeObsoleteHookArtifactsSpy = spyOn(
      migration,
      'removeObsoleteHookArtifacts',
    ).mockResolvedValue(undefined);
    installHooksSpy = spyOn(hooks, 'installHooks').mockResolvedValue(undefined);
    installSecretsBinarySpy = spyOn(secretsInstall, 'installSecretsBinary').mockResolvedValue(
      '/fake/bin/sonar-secrets',
    );
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    stateFileExistsSpy.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    isNewerVersionSpy.mockRestore();
    migrateHookScriptsSpy.mockRestore();
    removeObsoleteHookArtifactsSpy.mockRestore();
    installHooksSpy.mockRestore();
    installSecretsBinarySpy.mockRestore();
  });

  it('does nothing when state file does not exist', async () => {
    stateFileExistsSpy.mockReturnValue(false);

    await runPostUpdateActions();

    expect(loadStateSpy).not.toHaveBeenCalled();
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  it('does nothing when version is already up to date', async () => {
    isNewerVersionSpy.mockReturnValue(false);

    await runPostUpdateActions();

    expect(saveStateSpy).not.toHaveBeenCalled();
    expect(installHooksSpy).not.toHaveBeenCalled();
  });

  it('saves state with cliVersion bumped to the current version', async () => {
    await runPostUpdateActions();

    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    const savedState = saveStateSpy.mock.calls[0][0];
    expect(savedState.config.cliVersion).toBe(CURRENT_VERSION);
  });

  it('saves the reloaded state, not the pre-runActions snapshot', async () => {
    // loadState is called 7 times:
    //   1. version check in runPostUpdateActions
    //   2. inside migrateLegacyTelemetryEvents
    //   3. inside migrateDeclarativeIntegrations
    //   4. inside migrateClaudeCodeHooks
    //   5. inside updateSecretsBinaryIfNeeded
    //   6. inside updateScaScannerBinaryIfNeeded
    //   7. the reload after runActions (the fix being tested)
    const reloadedState = makeState();
    loadStateSpy
      .mockReturnValueOnce(makeState()) // call 1: version check
      .mockReturnValueOnce(makeState()) // call 2: migrateLegacyTelemetryEvents
      .mockReturnValueOnce(makeState()) // call 3: migrateDeclarativeIntegrations
      .mockReturnValueOnce(makeState()) // call 4: migrateClaudeCodeHooks
      .mockReturnValueOnce(makeState()) // call 5: updateSecretsBinaryIfNeeded
      .mockReturnValueOnce(makeState()) // call 6: updateScaScannerBinaryIfNeeded
      .mockReturnValueOnce(reloadedState); // call 7: reload

    await runPostUpdateActions();

    expect(saveStateSpy.mock.calls[0][0]).toBe(reloadedState);
  });

  it('passes previousVersion and CURRENT_VERSION to isNewerVersion', async () => {
    const state = makeState(); // cliVersion = '1.0.0'
    loadStateSpy.mockReturnValue(state);

    await runPostUpdateActions();

    expect(isNewerVersionSpy).toHaveBeenCalledWith('1.0.0', CURRENT_VERSION);
  });

  it('does not throw when post-update actions fail', async () => {
    // Second loadState call (inside migrateClaudeCodeHooks) throws
    loadStateSpy.mockReturnValueOnce(makeState()).mockImplementationOnce(() => {
      throw new Error('state load failed');
    });

    const actual = await runPostUpdateActions();

    expect(actual).toBeUndefined();
  });

  it('does not save state when post-update actions fail', async () => {
    loadStateSpy.mockReturnValueOnce(makeState()).mockImplementationOnce(() => {
      throw new Error('state load failed');
    });

    await runPostUpdateActions();

    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  it('removes sonar-a3s entries from state on upgrade', async () => {
    const state = makeState();
    state.agents['claude-code'].hooks.installed.push({
      name: 'sonar-a3s',
      type: 'PostToolUse',
      installedAt: new Date().toISOString(),
    });
    loadStateSpy.mockReturnValue(state);

    await runPostUpdateActions();

    const saved = saveStateSpy.mock.calls[0][0];
    expect(saved.agents['claude-code'].hooks.installed.some((h) => h.name === 'sonar-a3s')).toBe(
      false,
    );
  });
});

function makeLegacyCommandEvent(command: string): StoredCommandExecutedEvent {
  return {
    metadata: {
      event_id: randomUUID(),
      source: { domain: 'CLI' },
      event_type: 'Analytics.Cli.CliCommandExecuted',
      event_timestamp: String(Date.now()),
    },
    event_payload: {
      cli_installation_id: 'install-id',
      machine_id: 'machine-id',
      cli_version: '1.0.0',
      invocation_id: 'inv-id',
      os: 'linux',
      connection_type: null,
      user_uuid: null,
      organization_uuid_v4: null,
      sqs_installation_id: null,
      caller_agent: null,
      command,
      subcommand: null,
      result: 'success',
      distribution: DISTRIBUTION,
    },
  };
}

describe('migrateLegacyTelemetryEvents', () => {
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let saveStateSpy: Mock<typeof stateRepository.saveState>;
  let appendTelemetryEventSpy: Mock<typeof telemetryEvents.appendTelemetryEvent>;
  let getTelemetryDirSpy: Mock<typeof configConstants.getTelemetryDir>;
  let telemetryDir: string;

  beforeEach(() => {
    telemetryDir = fs.mkdtempSync(join(tmpdir(), 'cli-post-update-telemetry-'));
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeState());
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => {});
    appendTelemetryEventSpy = spyOn(telemetryEvents, 'appendTelemetryEvent').mockImplementation(
      () => {},
    );
    getTelemetryDirSpy = spyOn(configConstants, 'getTelemetryDir').mockReturnValue(telemetryDir);
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    appendTelemetryEventSpy.mockRestore();
    getTelemetryDirSpy.mockRestore();
    fs.rmSync(telemetryDir, { recursive: true, force: true });
  });

  it('does nothing when there are no legacy telemetry events', () => {
    // Default state has no telemetry.events queue.
    migrateLegacyTelemetryEvents();

    expect(appendTelemetryEventSpy).not.toHaveBeenCalled();
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  it('migrates each legacy event to telemetry-events.ndjson and clears the queue', () => {
    const state = makeState();
    const events = [makeLegacyCommandEvent('auth'), makeLegacyCommandEvent('analyze')];
    state.telemetry.events = events;
    loadStateSpy.mockReturnValue(state);

    migrateLegacyTelemetryEvents();

    expect(appendTelemetryEventSpy).toHaveBeenCalledTimes(2);
    expect(appendTelemetryEventSpy).toHaveBeenNthCalledWith(1, events[0]);
    expect(appendTelemetryEventSpy).toHaveBeenNthCalledWith(2, events[1]);

    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    expect(saveStateSpy.mock.calls[0][0].telemetry.events).toBeUndefined();
  });

  it('renames the on-disk findings.ndjson sink to telemetry-events.ndjson', () => {
    const oldPath = join(telemetryDir, 'findings.ndjson');
    const newPath = join(telemetryDir, 'telemetry-events.ndjson');
    fs.writeFileSync(oldPath, '{"event":"buffered"}\n');

    migrateLegacyTelemetryEvents();

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.readFileSync(newPath, 'utf-8')).toBe('{"event":"buffered"}\n');
  });

  it('appends the old sink contents when telemetry-events.ndjson already exists', () => {
    const oldPath = join(telemetryDir, 'findings.ndjson');
    const newPath = join(telemetryDir, 'telemetry-events.ndjson');
    fs.writeFileSync(newPath, '{"event":"existing"}\n');
    fs.writeFileSync(oldPath, '{"event":"buffered"}\n');

    migrateLegacyTelemetryEvents();

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.readFileSync(newPath, 'utf-8')).toBe('{"event":"existing"}\n{"event":"buffered"}\n');
  });
});

describe('migrateDeclarativeIntegrations', () => {
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let saveStateSpy: Mock<typeof stateRepository.saveState>;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'sonar-cli-post-update-'));
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeState());
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => {});
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
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
    loadStateSpy.mockReturnValue(state);

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

    await migrateDeclarativeIntegrations(registry);

    expect(fs.readFileSync(resourcePath, 'utf-8')).toBe('fresh content');
    expect(operationCalls).toEqual(['refresh-operation']);
    expect(fs.existsSync(newFeatureResourcePath)).toBe(false);
    expect(saveStateSpy).toHaveBeenCalledTimes(1);

    const savedState = saveStateSpy.mock.calls[0][0];
    expect(savedState.integrations.installed).toHaveLength(1);
    expect(savedState.integrations.installed[0].features).toHaveLength(1);
    const savedFeature = savedState.integrations.installed[0].features[0];
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
      dependencyType: 'binary',
      version: '2',
      installOrUpdate: ({ existingDependency }) => {
        existingDependencyPaths.push(existingDependency?.path ?? 'missing');
        installCalls.push('install');
        return {
          id: 'shared-dependency',
          dependencyType: 'binary',
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
      dependencyType: sharedDependency.dependencyType,
      version: '1',
      path: '/old/shared-dependency',
      updatedByCliVersion: '0.9.0',
      updatedAt: now,
    });
    loadStateSpy.mockReturnValue(state);

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

    await migrateDeclarativeIntegrations(registry);

    expect(existingDependencyPaths).toEqual(['/old/shared-dependency']);
    expect(installCalls).toEqual(['install']);
    expect(fs.readFileSync(dependencyPathA, 'utf-8')).toBe('/new/shared-dependency');
    expect(fs.readFileSync(dependencyPathB, 'utf-8')).toBe('/new/shared-dependency');
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
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
    loadStateSpy.mockReturnValue(state);

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

    await migrateDeclarativeIntegrations(registry);

    expect(capturedContexts).toHaveLength(1);
    expect('activeSubfeatures' in capturedContexts[0]).toBeTrue();
    expect(
      (capturedContexts[0] as ContainerIntegrationContext).activeSubfeatures.map((s) => s.id),
    ).toEqual(['sub-a']);

    const savedFeature = saveStateSpy.mock.calls[0][0].integrations.installed[0].features[0];
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
    loadStateSpy.mockReturnValue(state);

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

    await migrateDeclarativeIntegrations(registry);

    expect(capturedContexts).toHaveLength(1);
    expect(
      (capturedContexts[0] as ContainerIntegrationContext).activeSubfeatures.map((s) => s.id),
    ).toEqual(['sub-a']);

    const savedFeature = saveStateSpy.mock.calls[0][0].integrations.installed[0].features[0];
    expect(savedFeature.subfeatures).toHaveLength(1);
    expect(savedFeature.subfeatures![0]).toMatchObject({ featureId: 'sub-a' });
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
    loadStateSpy.mockReturnValue(state);

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

    await migrateDeclarativeIntegrations(registry);

    expect(capturedContexts).toHaveLength(1);
    expect('activeSubfeatures' in capturedContexts[0]).toBeFalse();
  });
});

describe('migrateClaudeCodeHooks', () => {
  let existsSyncSpy: Mock<typeof fs.existsSync>;
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let migrateHookScriptsSpy: Mock<typeof migration.migrateHookScripts>;
  let removeObsoleteHookArtifactsSpy: Mock<typeof migration.removeObsoleteHookArtifacts>;
  let installHooksSpy: Mock<typeof hooks.installHooks>;

  beforeEach(() => {
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeState());
    migrateHookScriptsSpy = spyOn(migration, 'migrateHookScripts').mockImplementation(() => {});
    removeObsoleteHookArtifactsSpy = spyOn(
      migration,
      'removeObsoleteHookArtifacts',
    ).mockResolvedValue(undefined);
    installHooksSpy = spyOn(hooks, 'installHooks').mockResolvedValue(undefined);
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    loadStateSpy.mockRestore();
    migrateHookScriptsSpy.mockRestore();
    removeObsoleteHookArtifactsSpy.mockRestore();
    installHooksSpy.mockRestore();
  });

  it('does not install hooks when agent is not configured and registry is empty', async () => {
    loadStateSpy.mockReturnValue(makeState()); // configured = false, no extensions

    await migrateClaudeCodeHooks(homedirFn);

    expect(installHooksSpy).not.toHaveBeenCalled();
  });

  it('does not install hooks when agent is configured but registry is empty and no global hooks dir exists', async () => {
    const state = makeStateWithExtensions([]); // configured, no extensions
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockReturnValue(false); // globalHooksDir does not exist

    await migrateClaudeCodeHooks(homedirFn);

    expect(installHooksSpy).not.toHaveBeenCalled();
  });

  it('does not install hooks when registry contains only skill extensions', async () => {
    const state = makeStateWithExtensions([]);
    state.agentExtensions = [
      {
        id: 'skill-id',
        agentId: 'claude-code',
        kind: 'skill',
        name: 'sonar-context-augmentation',
        projectRoot: '/some/project',
        global: false,
        updatedByCliVersion: '1.0.0',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockReturnValue(false); // global hooks dir does not exist

    await migrateClaudeCodeHooks(homedirFn);

    expect(installHooksSpy).not.toHaveBeenCalled();
    expect(migrateHookScriptsSpy).not.toHaveBeenCalled();
  });

  it('skips legacy migration when Claude is already tracked declaratively', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    state.integrations.installed.push({
      id: 'claude-integration-id',
      integrationId: 'claude-code',
      installedByCliVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedByCliVersion: '1.0.0',
      updatedAt: '2026-01-01T00:00:00.000Z',
      features: [
        {
          featureId: 'mcp-server',
          scope: 'project',
          targetRoot: '/proj/root',
          installedByCliVersion: '1.0.0',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedByCliVersion: '1.0.0',
          updatedAt: '2026-01-01T00:00:00.000Z',
          dependencies: [],
          resources: [],
          operations: [],
        },
      ],
    });
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(homedirFn);

    expect(installHooksSpy).not.toHaveBeenCalled();
    expect(migrateHookScriptsSpy).not.toHaveBeenCalled();
  });

  it('does not skip legacy migration for an empty declarative Claude container', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    state.integrations.installed.push({
      id: 'claude-integration-id',
      integrationId: 'claude-code',
      installedByCliVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedByCliVersion: '1.0.0',
      updatedAt: '2026-01-01T00:00:00.000Z',
      features: [],
    });
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(1);
    expect(migrateHookScriptsSpy).toHaveBeenCalledTimes(1);
  });

  it('installs hooks for each extension in the registry', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(1);
  });

  it('passes projectRoot and undefined globalDir for non-global extensions', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(homedirFn);

    expect(installHooksSpy).toHaveBeenCalledWith('/proj/root', undefined, false);
  });

  it('passes projectRoot and homedirFn() as globalDir for global extensions', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', true)]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(homedirFn);

    expect(installHooksSpy).toHaveBeenCalledWith('/proj/root', FAKE_HOME, false);
  });

  it('migrates hook scripts for each location before installing hooks', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(homedirFn);

    expect(migrateHookScriptsSpy).toHaveBeenCalledTimes(1);
    expect(migrateHookScriptsSpy).toHaveBeenCalledWith('/proj/root', undefined);
  });

  it('deduplicates locations - installs hooks once for repeated (projectRoot, globalDir)', async () => {
    const state = makeStateWithExtensions([
      makeExtension('/proj/root', false),
      makeExtension('/proj/root', false),
    ]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(1);
  });

  it('installs hooks for multiple distinct locations', async () => {
    const state = makeStateWithExtensions([
      makeExtension('/proj/alpha', false),
      makeExtension('/proj/beta', false),
    ]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to global migration when registry is empty, agent is configured, and global hooks dir exists', async () => {
    const state = makeStateWithExtensions([]); // configured, no extensions
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockReturnValue(true); // globalHooksDir exists

    await migrateClaudeCodeHooks(homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(1);
  });

  it('uses homedirFn() as both projectRoot and globalDir in the pre-registry fallback', async () => {
    const state = makeStateWithExtensions([]);
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockReturnValue(true);

    await migrateClaudeCodeHooks(homedirFn);

    expect(installHooksSpy).toHaveBeenCalledWith(FAKE_HOME, FAKE_HOME, false);
  });

  it('does not fall back when agent is not configured', async () => {
    const state = makeStateWithExtensions([], false); // configured = false
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockReturnValue(true); // hooks dir exists, but shouldn't matter

    await migrateClaudeCodeHooks(homedirFn);

    expect(installHooksSpy).not.toHaveBeenCalled();
  });

  it('continues installing remaining locations when one throws', async () => {
    const state = makeStateWithExtensions([
      makeExtension('/proj/alpha', false),
      makeExtension('/proj/beta', false),
    ]);
    loadStateSpy.mockReturnValue(state);
    migrateHookScriptsSpy.mockImplementationOnce(() => {
      throw new Error('migrate failed');
    });

    await migrateClaudeCodeHooks(homedirFn);

    // First location failed, but second location still ran
    expect(installHooksSpy).toHaveBeenCalledTimes(1);
    expect(installHooksSpy).toHaveBeenCalledWith('/proj/beta', undefined, false);
  });

  it('does not throw when a location migration fails', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    loadStateSpy.mockReturnValue(state);
    installHooksSpy.mockRejectedValue(new Error('hook install failed'));

    const actual = await migrateClaudeCodeHooks(homedirFn);

    expect(actual).toBeUndefined();
  });

  it('calls removeObsoleteHookArtifacts once per location with the sonar-a3s marker', async () => {
    const state = makeStateWithExtensions([
      makeExtension('/proj/alpha', false),
      makeExtension('/proj/beta', false),
    ]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(homedirFn);

    expect(removeObsoleteHookArtifactsSpy).toHaveBeenCalledTimes(2);
    expect(removeObsoleteHookArtifactsSpy).toHaveBeenCalledWith(
      '/proj/alpha',
      migration.OBSOLETE_A3S_MARKER,
    );
    expect(removeObsoleteHookArtifactsSpy).toHaveBeenCalledWith(
      '/proj/beta',
      migration.OBSOLETE_A3S_MARKER,
    );
  });
});

function makeStateWithSecrets(): CliState {
  const state = makeState();
  state.tools = {
    installed: [
      {
        name: 'sonar-secrets',
        version: '0.0.0.1',
        path: '/fake/bin/sonar-secrets-0.0.0.1-linux-x86-64',
        installedAt: '2026-01-01T00:00:00.000Z',
        installedByCliVersion: '1.0.0',
      },
    ],
  };
  return state;
}

describe('updateSecretsBinaryIfNeeded', () => {
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let installSecretsBinarySpy: Mock<typeof secretsInstall.installSecretsBinary>;

  beforeEach(() => {
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeStateWithSecrets());
    installSecretsBinarySpy = spyOn(secretsInstall, 'installSecretsBinary').mockResolvedValue(
      '/fake/bin/sonar-secrets',
    );
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    installSecretsBinarySpy.mockRestore();
  });

  it('does nothing when no previous binary is recorded in state', async () => {
    loadStateSpy.mockReturnValue(makeState()); // tools.installed is empty

    await updateSecretsBinaryIfNeeded();

    expect(installSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('calls installSecretsBinary when a previous installation is recorded in state', async () => {
    await updateSecretsBinaryIfNeeded();

    expect(installSecretsBinarySpy).toHaveBeenCalledTimes(1);
  });

  it('propagates errors from installSecretsBinary to the caller', () => {
    installSecretsBinarySpy.mockRejectedValue(new Error('download failed'));

    expect(updateSecretsBinaryIfNeeded()).rejects.toThrow('download failed');
  });
});

function makeStateWithScaScanner(): CliState {
  const state = makeState();
  state.tools = {
    installed: [
      {
        name: SCA_SCANNER_BINARY_NAME,
        version: '0.0.0.1',
        path: '/fake/bin/sca-scanner-cli-0.0.0.1-linux-x86-64',
        installedAt: '2026-01-01T00:00:00.000Z',
        installedByCliVersion: '1.0.0',
      },
    ],
  };
  return state;
}

describe('updateScaScannerBinaryIfNeeded', () => {
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let installScaScannerBinarySpy: Mock<typeof scaScannerInstall.installScaScannerBinary>;

  beforeEach(() => {
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeStateWithScaScanner());
    installScaScannerBinarySpy = spyOn(
      scaScannerInstall,
      'installScaScannerBinary',
    ).mockResolvedValue('/fake/bin/sca-scanner-cli');
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    installScaScannerBinarySpy.mockRestore();
  });

  it('does nothing when no previous binary is recorded in state', async () => {
    loadStateSpy.mockReturnValue(makeState()); // tools.installed is empty

    await updateScaScannerBinaryIfNeeded();

    expect(installScaScannerBinarySpy).not.toHaveBeenCalled();
  });

  it('calls installScaScannerBinary when a previous installation is recorded in state', async () => {
    await updateScaScannerBinaryIfNeeded();

    expect(installScaScannerBinarySpy).toHaveBeenCalledTimes(1);
  });

  it('propagates errors from installScaScannerBinary to the caller', () => {
    installScaScannerBinarySpy.mockRejectedValue(new Error('download failed'));

    expect(updateScaScannerBinaryIfNeeded()).rejects.toThrow('download failed');
  });
});

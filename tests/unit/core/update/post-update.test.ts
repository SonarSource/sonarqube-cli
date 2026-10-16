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

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';

import { supportedIntegrations } from '@/commands/integrate';
import { AuthResolver } from '@/core/auth/auth-resolver.ts';
import { createCliRuntime } from '@/core/commands/cli-runtime.ts';
import { IntegrationRegistry } from '@/core/framework/features';
import * as secretsInstall from '@/core/host/install/secrets.ts';
import { okAsync } from '@/core/result.ts';
import type { CliState } from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import type { PostUpdateDependencies } from '@/core/update/post-update.ts';
import {
  migrateDeclarativeIntegrations,
  runPostUpdateActions,
  runPostUpdateActionsSafely,
} from '@/core/update/post-update.ts';
import * as versionLib from '@/core/version.ts';

import { version as CURRENT_VERSION } from '../../../../package.json';
import { FakeConsole } from '../../../_common/fake-console.ts';

function makeDeps(): PostUpdateDependencies {
  const console = new FakeConsole();
  const authResolver = new AuthResolver();
  authResolver.resolveAuth = () => okAsync(null);
  return {
    supportedIntegrations,
    console,
    runtime: createCliRuntime({ authResolver, console, isAlphaEnabled: false }),
    // Empty: the default state records no integrations, so the global-integrations
    // migration returns before it would look a handler up.
    agentIntegrationHandlers: {},
  };
}

function makeState(): CliState {
  return getDefaultState('1.0.0');
}

describe('runPostUpdateActions', () => {
  let existsSyncSpy: Mock<typeof fs.existsSync>;
  let stateFileExistsSpy: Mock<typeof stateRepository.stateFileExists>;
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let tryLoadStateSpy: Mock<typeof stateRepository.tryLoadState>;
  let updateStateSpy: Mock<typeof stateRepository.updateState>;
  let isNewerVersionSpy: Mock<typeof versionLib.isNewerVersion>;
  let installSecretsBinarySpy: Mock<typeof secretsInstall.installSecretsBinary>;

  beforeEach(() => {
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    stateFileExistsSpy = spyOn(stateRepository, 'stateFileExists').mockReturnValue(true);
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeState());
    tryLoadStateSpy = spyOn(stateRepository, 'tryLoadState').mockReturnValue(makeState());
    updateStateSpy = spyOn(stateRepository, 'updateState').mockImplementation((update) =>
      update(stateRepository.loadState()),
    );
    isNewerVersionSpy = spyOn(versionLib, 'isNewerVersion').mockReturnValue(true);
    installSecretsBinarySpy = spyOn(secretsInstall, 'installSecretsBinary').mockResolvedValue(
      '/fake/bin/sonar-secrets',
    );
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    stateFileExistsSpy.mockRestore();
    loadStateSpy.mockRestore();
    tryLoadStateSpy.mockRestore();
    updateStateSpy.mockRestore();
    isNewerVersionSpy.mockRestore();
    installSecretsBinarySpy.mockRestore();
  });

  it('does nothing when state file does not exist', async () => {
    stateFileExistsSpy.mockReturnValue(false);

    await runPostUpdateActions(makeDeps());

    expect(loadStateSpy).not.toHaveBeenCalled();
    expect(updateStateSpy).not.toHaveBeenCalled();
  });

  it('swallows and warns on a throw when called through runPostUpdateActionsSafely', async () => {
    stateFileExistsSpy.mockImplementation(() => {
      throw new Error('state directory unreadable');
    });
    const deps = makeDeps();

    await runPostUpdateActionsSafely(deps);

    expect(
      (deps.console as FakeConsole).findCall('warn', 'state directory unreadable'),
    ).toBeDefined();
  });

  it('warns when post-update actions fail', async () => {
    updateStateSpy.mockImplementation(() => {
      throw new Error('state file is read-only');
    });
    const deps = makeDeps();

    await runPostUpdateActions(deps);

    expect((deps.console as FakeConsole).findCall('warn', 'state file is read-only')).toBeDefined();
  });

  it('does nothing when version is already up to date', async () => {
    isNewerVersionSpy.mockReturnValue(false);

    await runPostUpdateActions(makeDeps());

    expect(updateStateSpy).not.toHaveBeenCalled();
  });

  it('saves state with cliVersion bumped to the current version', async () => {
    await runPostUpdateActions(makeDeps());

    expect(updateStateSpy).toHaveBeenCalledTimes(1);
    const savedState = makeState();
    updateStateSpy.mock.calls[0][0](savedState);
    expect(savedState.config.cliVersion).toBe(CURRENT_VERSION);
  });

  it('clears Beta command warning history after an update', async () => {
    const state = makeState();
    state.config.betaCommandWarnings = {
      context: '1.0.0',
      'analyze preview': '1.0.0',
    };
    loadStateSpy.mockReturnValue(state);

    await runPostUpdateActions(makeDeps());

    expect(state.config.betaCommandWarnings).toBeUndefined();
  });

  it('applies the version update to the latest state', async () => {
    await runPostUpdateActions(makeDeps());

    const latest = makeState();
    latest.config.updateCheck = { lastCheckedAt: '2026-01-01' };
    updateStateSpy.mock.calls[0][0](latest);
    expect(latest.config.cliVersion).toBe(CURRENT_VERSION);
    expect(latest.config.updateCheck).toEqual({ lastCheckedAt: '2026-01-01' });
  });

  it('passes previousVersion and CURRENT_VERSION to isNewerVersion', async () => {
    const state = makeState(); // cliVersion = '1.0.0'
    loadStateSpy.mockReturnValue(state);

    await runPostUpdateActions(makeDeps());

    expect(isNewerVersionSpy).toHaveBeenCalledWith('1.0.0', CURRENT_VERSION);
  });

  it('does not throw when post-update actions fail', async () => {
    loadStateSpy.mockImplementationOnce(() => {
      throw new Error('state load failed');
    });

    const actual = await runPostUpdateActions(makeDeps());

    expect(actual).toBeUndefined();
  });

  it('does not save state when post-update actions fail', async () => {
    loadStateSpy.mockImplementationOnce(() => {
      throw new Error('state load failed');
    });

    await runPostUpdateActions(makeDeps());

    expect(updateStateSpy).not.toHaveBeenCalled();
  });

  it('still saves state when only migrateKnownServerProjectMappings fails', async () => {
    loadStateSpy
      .mockReturnValueOnce(makeState())
      .mockReturnValueOnce(makeState())
      .mockImplementationOnce(() => {
        throw new Error('state load failed');
      });

    await runPostUpdateActions(makeDeps());

    expect(updateStateSpy).toHaveBeenCalledTimes(1);
  });
});

describe('migrateDeclarativeIntegrations', () => {
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let updateStateSpy: Mock<typeof stateRepository.updateState>;

  beforeEach(() => {
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeState());
    updateStateSpy = spyOn(stateRepository, 'updateState').mockImplementation((update) =>
      update(stateRepository.loadState()),
    );
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    updateStateSpy.mockRestore();
  });

  it('loads state, reconciles the registry against it, and saves when changed', async () => {
    const state = makeState();
    loadStateSpy.mockReturnValue(state);

    const registry = new IntegrationRegistry();

    await migrateDeclarativeIntegrations(registry, new FakeConsole());

    expect(loadStateSpy).toHaveBeenCalledTimes(1);
    expect(updateStateSpy).not.toHaveBeenCalled();
  });

  it('saves state when reconciliation reports a change', async () => {
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
          featureId: 'removed-feature',
          scope: 'project',
          targetRoot: '/does-not-matter',
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

    // Registry has no matching feature declaration, so the unknown
    // 'removed-feature' entry gets pruned — that alone should trigger a save.
    const registry = new IntegrationRegistry();
    registry.register({
      id: 'test-integration',
      displayName: 'Test integration',
      features: [],
    });

    await migrateDeclarativeIntegrations(registry, new FakeConsole());

    expect(updateStateSpy).toHaveBeenCalledTimes(1);
    expect(state.integrations.installed).toHaveLength(0);
  });
});

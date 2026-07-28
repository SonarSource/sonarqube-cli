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
import { CLAUDE_INTEGRATION_ID } from '@/commands/integrate/claude/declaration.ts';
import * as hooks from '@/commands/integrate/claude/hooks.ts';
import * as secretsInstall from '@/core/host/install/secrets.ts';
import * as migration from '@/core/host/migration.ts';
import type { PostUpdateDependencies } from '@/core/host/post-update.ts';
import { runPostUpdateActions } from '@/core/host/post-update.ts';
import type { CliState } from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import * as versionLib from '@/core/version.ts';

import { version as CURRENT_VERSION } from '../../../../package.json';

function makeDeps(): PostUpdateDependencies {
  return {
    supportedIntegrations,
    claudeIntegrationId: CLAUDE_INTEGRATION_ID,
    installHooks: hooks.installHooks,
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
    tryLoadStateSpy = spyOn(stateRepository, 'tryLoadState').mockReturnValue(makeState());
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
    tryLoadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    isNewerVersionSpy.mockRestore();
    migrateHookScriptsSpy.mockRestore();
    removeObsoleteHookArtifactsSpy.mockRestore();
    installHooksSpy.mockRestore();
    installSecretsBinarySpy.mockRestore();
  });

  it('does nothing when state file does not exist', async () => {
    stateFileExistsSpy.mockReturnValue(false);

    await runPostUpdateActions(makeDeps());

    expect(loadStateSpy).not.toHaveBeenCalled();
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  it('does nothing when version is already up to date', async () => {
    isNewerVersionSpy.mockReturnValue(false);

    await runPostUpdateActions(makeDeps());

    expect(saveStateSpy).not.toHaveBeenCalled();
    expect(installHooksSpy).not.toHaveBeenCalled();
  });

  it('saves state with cliVersion bumped to the current version', async () => {
    await runPostUpdateActions(makeDeps());

    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    const savedState = saveStateSpy.mock.calls[0][0];
    expect(savedState.config.cliVersion).toBe(CURRENT_VERSION);
  });

  it('saves the reloaded state, not the pre-runActions snapshot', async () => {
    // The version check reads via tryLoadState, so loadState is called 6 times:
    //   1. inside migrateLegacyTelemetryEvents
    //   2. inside migrateDeclarativeIntegrations
    //   3. inside migrateClaudeCodeHooks
    //   4. inside updateSecretsBinaryIfNeeded
    //   5. inside updateScaScannerBinaryIfNeeded
    //   6. the reload after runActions (the fix being tested)
    const reloadedState = makeState();
    loadStateSpy
      .mockReturnValueOnce(makeState()) // call 1: migrateLegacyTelemetryEvents
      .mockReturnValueOnce(makeState()) // call 2: migrateDeclarativeIntegrations
      .mockReturnValueOnce(makeState()) // call 3: migrateClaudeCodeHooks
      .mockReturnValueOnce(makeState()) // call 4: updateSecretsBinaryIfNeeded
      .mockReturnValueOnce(makeState()) // call 5: updateScaScannerBinaryIfNeeded
      .mockReturnValueOnce(reloadedState); // call 6: reload

    await runPostUpdateActions(makeDeps());

    expect(saveStateSpy.mock.calls[0][0]).toBe(reloadedState);
  });

  it('passes previousVersion and CURRENT_VERSION to isNewerVersion', async () => {
    const state = makeState(); // cliVersion = '1.0.0'
    loadStateSpy.mockReturnValue(state);

    await runPostUpdateActions(makeDeps());

    expect(isNewerVersionSpy).toHaveBeenCalledWith('1.0.0', CURRENT_VERSION);
  });

  it('does not throw when post-update actions fail', async () => {
    // Second loadState call (inside migrateClaudeCodeHooks) throws
    loadStateSpy.mockReturnValueOnce(makeState()).mockImplementationOnce(() => {
      throw new Error('state load failed');
    });

    const actual = await runPostUpdateActions(makeDeps());

    expect(actual).toBeUndefined();
  });

  it('does not save state when post-update actions fail', async () => {
    loadStateSpy.mockReturnValueOnce(makeState()).mockImplementationOnce(() => {
      throw new Error('state load failed');
    });

    await runPostUpdateActions(makeDeps());

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

    await runPostUpdateActions(makeDeps());

    const saved = saveStateSpy.mock.calls[0][0];
    expect(saved.agents['claude-code'].hooks.installed.some((h) => h.name === 'sonar-a3s')).toBe(
      false,
    );
  });
});

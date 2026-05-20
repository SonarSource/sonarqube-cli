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

import { version as CURRENT_VERSION } from '../../../../../package.json';
import * as cagInstall from '../../../../../src/cli/commands/_common/install/context-augmentation';
import * as secretsInstall from '../../../../../src/cli/commands/_common/install/secrets';
import * as contextAugmentation from '../../../../../src/cli/commands/integrate/_common/context-augmentation';
import * as hooks from '../../../../../src/cli/commands/integrate/claude/hooks';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../../../src/lib/install-types';
import * as migration from '../../../../../src/lib/migration';
import {
  migrateClaudeCodeHooks,
  runPostUpdateActions,
  updateContextAugmentationIfNeeded,
  updateSecretsBinaryIfNeeded,
} from '../../../../../src/lib/post-update';
import * as stateRepository from '../../../../../src/lib/repository/state-repository';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../../../src/lib/signatures';
import type { CliState, HookExtension, SkillExtension } from '../../../../../src/lib/state';
import { getDefaultState } from '../../../../../src/lib/state';
import * as stateManager from '../../../../../src/lib/state-manager';
import * as versionLib from '../../../../../src/lib/version';

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

function makeContextSkill(
  projectRoot: string,
  agentId = 'claude-code',
  version = '0.0.0-old',
): SkillExtension {
  return {
    id: `skill-${agentId}-${projectRoot}`,
    agentId,
    kind: 'skill',
    name: CONTEXT_AUGMENTATION_BINARY_NAME,
    projectRoot,
    global: false,
    projectKey: 'project-key',
    orgKey: 'org-key',
    serverUrl: 'https://sonarcloud.io',
    updatedByCliVersion: '1.0.0',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version,
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
    // loadState is called 5 times:
    //   1. version check in runPostUpdateActions
    //   2. inside migrateClaudeCodeHooks
    //   3. inside updateSecretsBinaryIfNeeded
    //   4. inside updateContextAugmentationIfNeeded
    //   5. the reload after runActions (the fix being tested)
    const reloadedState = makeState();
    loadStateSpy
      .mockReturnValueOnce(makeState()) // call 1: version check
      .mockReturnValueOnce(makeState()) // call 2: migrateClaudeCodeHooks
      .mockReturnValueOnce(makeState()) // call 3: updateSecretsBinaryIfNeeded
      .mockReturnValueOnce(makeState()) // call 4: updateContextAugmentationIfNeeded
      .mockReturnValueOnce(reloadedState); // call 5: reload

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

function makeStateWithContextAugmentation(): CliState {
  const state = makeState();
  state.tools = {
    installed: [
      {
        name: CONTEXT_AUGMENTATION_BINARY_NAME,
        version: '0.0.0.1',
        path: '/fake/bin/sonar-context-augmentation-0.0.0.1-linux-x86-64',
        installedAt: '2026-01-01T00:00:00.000Z',
        installedByCliVersion: '1.0.0',
      },
    ],
  };
  return state;
}

describe('updateContextAugmentationIfNeeded', () => {
  let existsSyncSpy: Mock<typeof fs.existsSync>;
  let statSyncSpy: Mock<typeof fs.statSync>;
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let installContextAugmentationBinarySpy: Mock<typeof cagInstall.installContextAugmentationBinary>;
  let installContextAugmentationSkillSpy: Mock<
    typeof contextAugmentation.installContextAugmentationSkill
  >;
  let recordSkillExtensionInStateSpy: Mock<typeof stateManager.recordSkillExtensionInState>;

  beforeEach(() => {
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    statSyncSpy = spyOn(fs, 'statSync').mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats);
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeState());
    installContextAugmentationBinarySpy = spyOn(
      cagInstall,
      'installContextAugmentationBinary',
    ).mockResolvedValue('/fake/bin/sonar-context-augmentation');
    installContextAugmentationSkillSpy = spyOn(
      contextAugmentation,
      'installContextAugmentationSkill',
    ).mockResolvedValue(true);
    recordSkillExtensionInStateSpy = spyOn(
      stateManager,
      'recordSkillExtensionInState',
    ).mockImplementation(() => {});
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    statSyncSpy.mockRestore();
    loadStateSpy.mockRestore();
    installContextAugmentationBinarySpy.mockRestore();
    installContextAugmentationSkillSpy.mockRestore();
    recordSkillExtensionInStateSpy.mockRestore();
  });

  it('does nothing when no previous CAG install or skill is recorded', async () => {
    await updateContextAugmentationIfNeeded();

    expect(installContextAugmentationBinarySpy).not.toHaveBeenCalled();
    expect(installContextAugmentationSkillSpy).not.toHaveBeenCalled();
  });

  it('downloads CAG when a previous binary installation is recorded', async () => {
    loadStateSpy.mockReturnValue(makeStateWithContextAugmentation());

    await updateContextAugmentationIfNeeded();

    expect(installContextAugmentationBinarySpy).toHaveBeenCalledTimes(1);
    expect(installContextAugmentationSkillSpy).not.toHaveBeenCalled();
  });

  it('downloads CAG and refreshes all registered project skills', async () => {
    const state = makeStateWithContextAugmentation();
    state.agentExtensions = [
      makeContextSkill('/proj/alpha', 'claude-code'),
      makeContextSkill('/proj/beta', 'copilot-cli'),
    ];
    loadStateSpy.mockReturnValue(state);

    await updateContextAugmentationIfNeeded();

    expect(installContextAugmentationBinarySpy).toHaveBeenCalledTimes(1);
    expect(installContextAugmentationSkillSpy).toHaveBeenNthCalledWith(1, {
      binaryPath: '/fake/bin/sonar-context-augmentation',
      agent: 'claude-code',
      projectRoot: '/proj/alpha',
      reportFailure: false,
    });
    expect(installContextAugmentationSkillSpy).toHaveBeenNthCalledWith(2, {
      binaryPath: '/fake/bin/sonar-context-augmentation',
      agent: 'copilot',
      projectRoot: '/proj/beta',
      reportFailure: false,
    });
    expect(recordSkillExtensionInStateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude-code',
        projectRoot: '/proj/alpha',
        updatedByCliVersion: CURRENT_VERSION,
        version: SONAR_CONTEXT_AUGMENTATION_VERSION,
      }),
    );
    expect(recordSkillExtensionInStateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'copilot-cli',
        projectRoot: '/proj/beta',
        updatedByCliVersion: CURRENT_VERSION,
        version: SONAR_CONTEXT_AUGMENTATION_VERSION,
      }),
    );
  });

  it('skips deleted project roots and unsupported agent ids', async () => {
    const state = makeStateWithContextAugmentation();
    state.agentExtensions = [
      makeContextSkill('/proj/missing', 'claude-code'),
      makeContextSkill('/proj/unknown', 'unknown-agent'),
    ];
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockImplementation((path) => path !== '/proj/missing');

    await updateContextAugmentationIfNeeded();

    expect(installContextAugmentationSkillSpy).not.toHaveBeenCalled();
    expect(recordSkillExtensionInStateSpy).not.toHaveBeenCalled();
  });

  it('continues refreshing remaining skills when one skill install fails', async () => {
    const state = makeStateWithContextAugmentation();
    state.agentExtensions = [
      makeContextSkill('/proj/alpha', 'claude-code'),
      makeContextSkill('/proj/beta', 'copilot-cli'),
    ];
    loadStateSpy.mockReturnValue(state);
    installContextAugmentationSkillSpy.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await updateContextAugmentationIfNeeded();

    expect(recordSkillExtensionInStateSpy).toHaveBeenCalledTimes(1);
    expect(recordSkillExtensionInStateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'copilot-cli',
        projectRoot: '/proj/beta',
      }),
    );
  });

  it('continues refreshing remaining skills when one skill install throws', async () => {
    const state = makeStateWithContextAugmentation();
    state.agentExtensions = [
      makeContextSkill('/proj/alpha', 'claude-code'),
      makeContextSkill('/proj/beta', 'copilot-cli'),
    ];
    loadStateSpy.mockReturnValue(state);
    installContextAugmentationSkillSpy
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce(true);

    await updateContextAugmentationIfNeeded();

    expect(recordSkillExtensionInStateSpy).toHaveBeenCalledTimes(1);
    expect(recordSkillExtensionInStateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'copilot-cli',
        projectRoot: '/proj/beta',
      }),
    );
  });

  it('propagates errors from the CAG binary update to the caller', () => {
    loadStateSpy.mockReturnValue(makeStateWithContextAugmentation());
    installContextAugmentationBinarySpy.mockRejectedValue(new Error('download failed'));

    expect(updateContextAugmentationIfNeeded()).rejects.toThrow('download failed');
  });
});

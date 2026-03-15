/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as stateManager from '../../src/lib/state-manager';
import * as versionLib from '../../src/lib/version';
import * as migration from '../../src/lib/migration';
import * as hooks from '../../src/cli/commands/integrate/claude/hooks';
import { runPostUpdateActions, migrateClaudeCodeHooks } from '../../src/lib/post-update';
import { getDefaultState } from '../../src/lib/state';
import type { CliState, HookExtension } from '../../src/lib/state';
import { version as CURRENT_VERSION } from '../../package.json';

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
  let existsSyncSpy: Mock<Extract<(typeof fs)['existsSync'], (...args: any[]) => any>>;
  let loadStateSpy: Mock<Extract<(typeof stateManager)['loadState'], (...args: any[]) => any>>;
  let saveStateSpy: Mock<Extract<(typeof stateManager)['saveState'], (...args: any[]) => any>>;
  let isNewerVersionSpy: Mock<
    Extract<(typeof versionLib)['isNewerVersion'], (...args: any[]) => any>
  >;
  let migrateHookScriptsSpy: Mock<
    Extract<(typeof migration)['migrateHookScripts'], (...args: any[]) => any>
  >;
  let installHooksSpy: Mock<Extract<(typeof hooks)['installHooks'], (...args: any[]) => any>>;

  beforeEach(() => {
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(makeState());
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
    isNewerVersionSpy = spyOn(versionLib, 'isNewerVersion').mockReturnValue(true);
    migrateHookScriptsSpy = spyOn(migration, 'migrateHookScripts').mockImplementation(() => {});
    installHooksSpy = spyOn(hooks, 'installHooks').mockResolvedValue(undefined);
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    isNewerVersionSpy.mockRestore();
    migrateHookScriptsSpy.mockRestore();
    installHooksSpy.mockRestore();
  });

  it('does nothing when state file does not exist', async () => {
    existsSyncSpy.mockReturnValue(false);

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
});

describe('migrateClaudeCodeHooks', () => {
  let existsSyncSpy: Mock<Extract<(typeof fs)['existsSync'], (...args: any[]) => any>>;
  let loadStateSpy: Mock<Extract<(typeof stateManager)['loadState'], (...args: any[]) => any>>;
  let migrateHookScriptsSpy: Mock<
    Extract<(typeof migration)['migrateHookScripts'], (...args: any[]) => any>
  >;
  let installHooksSpy: Mock<Extract<(typeof hooks)['installHooks'], (...args: any[]) => any>>;

  beforeEach(() => {
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(makeState());
    migrateHookScriptsSpy = spyOn(migration, 'migrateHookScripts').mockImplementation(() => {});
    installHooksSpy = spyOn(hooks, 'installHooks').mockResolvedValue(undefined);
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    loadStateSpy.mockRestore();
    migrateHookScriptsSpy.mockRestore();
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
});

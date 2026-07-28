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

import { CLAUDE_INTEGRATION_ID } from '@/commands/integrate/claude/declaration.ts';
import * as hooks from '@/commands/integrate/claude/hooks.ts';
import * as migration from '@/core/host/migration.ts';
import type { CliState, HookExtension } from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import { migrateClaudeCodeHooks } from '@/core/update/claude-hooks-migration.ts';

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

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).not.toHaveBeenCalled();
  });

  it('does not install hooks when agent is configured but registry is empty and no global hooks dir exists', async () => {
    const state = makeStateWithExtensions([]); // configured, no extensions
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockReturnValue(false); // globalHooksDir does not exist

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

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

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

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

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

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

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(1);
    expect(migrateHookScriptsSpy).toHaveBeenCalledTimes(1);
  });

  it('installs hooks for each extension in the registry', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(1);
  });

  it('passes projectRoot and undefined globalDir for non-global extensions', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledWith('/proj/root', undefined, false);
  });

  it('passes projectRoot and homedirFn() as globalDir for global extensions', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', true)]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledWith('/proj/root', FAKE_HOME, false);
  });

  it('migrates hook scripts for each location before installing hooks', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(migrateHookScriptsSpy).toHaveBeenCalledTimes(1);
    expect(migrateHookScriptsSpy).toHaveBeenCalledWith('/proj/root', undefined);
  });

  it('deduplicates locations - installs hooks once for repeated (projectRoot, globalDir)', async () => {
    const state = makeStateWithExtensions([
      makeExtension('/proj/root', false),
      makeExtension('/proj/root', false),
    ]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(1);
  });

  it('installs hooks for multiple distinct locations', async () => {
    const state = makeStateWithExtensions([
      makeExtension('/proj/alpha', false),
      makeExtension('/proj/beta', false),
    ]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to global migration when registry is empty, agent is configured, and global hooks dir exists', async () => {
    const state = makeStateWithExtensions([]); // configured, no extensions
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockReturnValue(true); // globalHooksDir exists

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledTimes(1);
  });

  it('uses homedirFn() as both projectRoot and globalDir in the pre-registry fallback', async () => {
    const state = makeStateWithExtensions([]);
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockReturnValue(true);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    expect(installHooksSpy).toHaveBeenCalledWith(FAKE_HOME, FAKE_HOME, false);
  });

  it('does not fall back when agent is not configured', async () => {
    const state = makeStateWithExtensions([], false); // configured = false
    loadStateSpy.mockReturnValue(state);
    existsSyncSpy.mockReturnValue(true); // hooks dir exists, but shouldn't matter

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

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

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

    // First location failed, but second location still ran
    expect(installHooksSpy).toHaveBeenCalledTimes(1);
    expect(installHooksSpy).toHaveBeenCalledWith('/proj/beta', undefined, false);
  });

  it('does not throw when a location migration fails', async () => {
    const state = makeStateWithExtensions([makeExtension('/proj/root', false)]);
    loadStateSpy.mockReturnValue(state);
    installHooksSpy.mockRejectedValue(new Error('hook install failed'));

    const actual = await migrateClaudeCodeHooks(
      hooks.installHooks,
      CLAUDE_INTEGRATION_ID,
      homedirFn,
    );

    expect(actual).toBeUndefined();
  });

  it('calls removeObsoleteHookArtifacts once per location with the sonar-a3s marker', async () => {
    const state = makeStateWithExtensions([
      makeExtension('/proj/alpha', false),
      makeExtension('/proj/beta', false),
    ]);
    loadStateSpy.mockReturnValue(state);

    await migrateClaudeCodeHooks(hooks.installHooks, CLAUDE_INTEGRATION_ID, homedirFn);

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

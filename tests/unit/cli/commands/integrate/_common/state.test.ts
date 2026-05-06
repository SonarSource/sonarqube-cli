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

import { homedir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { version as VERSION } from '../../../../../../package.json';
import {
  recordAgentExtensions,
  withAgentState,
} from '../../../../../../src/cli/commands/integrate/_common/state';
import logger from '../../../../../../src/lib/logger';
import * as stateRepository from '../../../../../../src/lib/repository/state-repository';
import {
  type AgentExtension,
  type CliState,
  getDefaultState,
  type HookExtension,
  type InstructionsExtension,
} from '../../../../../../src/lib/state';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../../src/ui';

const AGENT_ID = 'test-agent';
const PROJECT_ROOT = '/project/root';

function isHook(ext: AgentExtension): ext is HookExtension {
  return ext.kind === 'hook';
}

function isInstructions(ext: AgentExtension): ext is InstructionsExtension {
  return ext.kind === 'instructions';
}

describe('withAgentState', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let loggerWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    loggerWarnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    loadStateSpy?.mockRestore();
    saveStateSpy?.mockRestore();
    loggerWarnSpy.mockRestore();
  });

  it('loads state, marks the agent configured at the current CLI version, runs the mutator, then saves', async () => {
    const baseState = getDefaultState('test');
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(baseState);
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => {});
    let mutatorState: CliState | undefined;

    await withAgentState(AGENT_ID, (state) => {
      mutatorState = state;
    });

    expect(loadStateSpy).toHaveBeenCalledTimes(1);
    expect(mutatorState).toBe(baseState);
    expect(baseState.agents[AGENT_ID]?.configured).toBe(true);
    expect(baseState.agents[AGENT_ID]?.configuredAt).toBeDefined();
    expect(VERSION).toBeDefined();
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    expect(saveStateSpy).toHaveBeenCalledWith(baseState);
  });

  it('awaits async mutators before saving', async () => {
    const baseState = getDefaultState('test');
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(baseState);
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => {});
    let mutatorRan = false;

    await withAgentState(AGENT_ID, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      mutatorRan = true;
    });

    expect(mutatorRan).toBe(true);
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when loadState fails — emits a UI warning and a logger.warn', async () => {
    loadStateSpy = spyOn(stateRepository, 'loadState').mockImplementation(() => {
      throw new Error('disk error');
    });
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => {});

    await withAgentState(AGENT_ID, () => {
      throw new Error('mutator should not run');
    });

    const warnCall = getMockUiCalls().find(
      (c) =>
        c.method === 'warn' &&
        (c.args[0] as string).includes('Failed to update configuration state') &&
        (c.args[0] as string).includes('disk error'),
    );
    expect(warnCall).toBeDefined();
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when saveState fails — emits a UI warning and a logger.warn', async () => {
    const baseState = getDefaultState('test');
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(baseState);
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => {
      throw new Error('write failed');
    });

    await withAgentState(AGENT_ID, () => {});

    const warnCall = getMockUiCalls().find(
      (c) =>
        c.method === 'warn' &&
        (c.args[0] as string).includes('Failed to update configuration state') &&
        (c.args[0] as string).includes('write failed'),
    );
    expect(warnCall).toBeDefined();
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the mutator itself throws', async () => {
    const baseState = getDefaultState('test');
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(baseState);
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => {});

    await withAgentState(AGENT_ID, () => {
      throw new Error('boom');
    });

    const warnCall = getMockUiCalls().find(
      (c) => c.method === 'warn' && (c.args[0] as string).includes('boom'),
    );
    expect(warnCall).toBeDefined();
    // Mutator threw before saveState was reached.
    expect(saveStateSpy).not.toHaveBeenCalled();
  });
});

describe('recordAgentExtensions', () => {
  let state: CliState;

  beforeEach(() => {
    state = getDefaultState('test');
  });

  it('upserts a HookExtension with the expected shape', () => {
    recordAgentExtensions(state, AGENT_ID, PROJECT_ROOT, false, [
      {
        kind: 'hook',
        name: 'sonar-secrets',
        hookType: 'PreToolUse',
        attrs: { projectKey: 'p', orgKey: 'o', serverUrl: 'https://example.com' },
      },
    ]);

    const hooks = state.agentExtensions.filter(isHook);
    expect(hooks).toHaveLength(1);
    const ext = hooks[0];
    expect(ext.agentId).toBe(AGENT_ID);
    expect(ext.projectRoot).toBe(PROJECT_ROOT);
    expect(ext.global).toBe(false);
    expect(ext.name).toBe('sonar-secrets');
    expect(ext.hookType).toBe('PreToolUse');
    expect(ext.projectKey).toBe('p');
    expect(ext.orgKey).toBe('o');
    expect(ext.serverUrl).toBe('https://example.com');
    expect(ext.updatedByCliVersion).toBe(VERSION);
    expect(ext.updatedAt).toBeDefined();
  });

  it('upserts an InstructionsExtension with the expected shape', () => {
    recordAgentExtensions(state, AGENT_ID, PROJECT_ROOT, false, [
      { kind: 'instructions', name: 'sonar-prompt-secrets' },
    ]);

    const instructions = state.agentExtensions.filter(isInstructions);
    expect(instructions).toHaveLength(1);
    const ext = instructions[0];
    expect(ext.agentId).toBe(AGENT_ID);
    expect(ext.projectRoot).toBe(PROJECT_ROOT);
    expect(ext.global).toBe(false);
    expect(ext.name).toBe('sonar-prompt-secrets');
  });

  it('defaults projectRoot to homedir() and global=true when isGlobal is true', () => {
    recordAgentExtensions(state, AGENT_ID, PROJECT_ROOT, true, [
      { kind: 'hook', name: 'sonar-secrets', hookType: 'PreToolUse' },
    ]);

    const hooks = state.agentExtensions.filter(isHook);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].projectRoot).toBe(homedir());
    expect(hooks[0].global).toBe(true);
  });

  it('respects spec-level projectRoot/global override (the SQAA case)', () => {
    // Run-level isGlobal=true, but the spec forces project scope (sonar-sqaa
    // is always project-scoped even on a global Claude install).
    recordAgentExtensions(state, AGENT_ID, PROJECT_ROOT, true, [
      {
        kind: 'hook',
        name: 'sonar-sqaa',
        hookType: 'PostToolUse',
        projectRoot: PROJECT_ROOT,
        global: false,
      },
    ]);

    const hooks = state.agentExtensions.filter(isHook);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe('sonar-sqaa');
    expect(hooks[0].projectRoot).toBe(PROJECT_ROOT);
    expect(hooks[0].global).toBe(false);
  });

  it('is idempotent — re-recording the same hook spec yields a single entry', () => {
    const spec = {
      kind: 'hook' as const,
      name: 'sonar-secrets',
      hookType: 'PreToolUse' as const,
    };

    recordAgentExtensions(state, AGENT_ID, PROJECT_ROOT, false, [spec]);
    recordAgentExtensions(state, AGENT_ID, PROJECT_ROOT, false, [spec]);

    const hooks = state.agentExtensions.filter(
      (e) => isHook(e) && e.name === 'sonar-secrets' && e.hookType === 'PreToolUse',
    );
    expect(hooks).toHaveLength(1);
  });

  it('is idempotent for the instructions kind — guards agentExtensionEquals on the new union variant', () => {
    const spec = { kind: 'instructions' as const, name: 'sonar-prompt-secrets' };

    recordAgentExtensions(state, AGENT_ID, PROJECT_ROOT, false, [spec]);
    recordAgentExtensions(state, AGENT_ID, PROJECT_ROOT, false, [spec]);

    const instructions = state.agentExtensions.filter(
      (e) => isInstructions(e) && e.name === 'sonar-prompt-secrets',
    );
    expect(instructions).toHaveLength(1);
  });

  it('records multiple specs in a single call', () => {
    recordAgentExtensions(state, AGENT_ID, PROJECT_ROOT, false, [
      { kind: 'hook', name: 'sonar-secrets', hookType: 'PreToolUse' },
      { kind: 'instructions', name: 'sonar-prompt-secrets' },
    ]);

    expect(state.agentExtensions.filter(isHook)).toHaveLength(1);
    expect(state.agentExtensions.filter(isInstructions)).toHaveLength(1);
  });
});

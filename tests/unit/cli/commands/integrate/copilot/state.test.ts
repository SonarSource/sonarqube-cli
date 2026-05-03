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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { updateCopilotState } from '../../../../../../src/cli/commands/integrate/copilot/state';
import * as stateRepository from '../../../../../../src/lib/repository/state-repository';
import {
  type AgentExtension,
  type CliState,
  getDefaultState,
  type HookExtension,
  type InstructionsExtension,
} from '../../../../../../src/lib/state';

const COPILOT_AGENT_ID = 'copilot-cli';
const PROJECT_ROOT = '/project/root';

function isHook(ext: AgentExtension): ext is HookExtension {
  return ext.kind === 'hook';
}

function isInstructions(ext: AgentExtension): ext is InstructionsExtension {
  return ext.kind === 'instructions';
}

describe('updateCopilotState', () => {
  let state: CliState;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    state = getDefaultState('test');
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(state);
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => {});
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
  });

  it('marks copilot-cli as configured and records both hook and instructions extensions when both were installed', async () => {
    await updateCopilotState(PROJECT_ROOT, false, {
      hookInstalled: true,
      instructionsInstalled: true,
    });

    expect(state.agents[COPILOT_AGENT_ID]?.configured).toBe(true);
    expect(saveStateSpy).toHaveBeenCalledTimes(1);

    const hooks = state.agentExtensions.filter(isHook);
    const instructions = state.agentExtensions.filter(isInstructions);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe('sonar-secrets');
    expect(hooks[0].hookType).toBe('PreToolUse');
    expect(hooks[0].agentId).toBe(COPILOT_AGENT_ID);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].name).toBe('sonar-prompt-secrets');
    expect(instructions[0].agentId).toBe(COPILOT_AGENT_ID);
  });

  it('records only the instructions extension when the hook write was skipped (global hook owns the scope)', async () => {
    await updateCopilotState(PROJECT_ROOT, false, {
      hookInstalled: false,
      instructionsInstalled: true,
    });

    expect(state.agentExtensions.filter(isHook)).toHaveLength(0);
    const instructions = state.agentExtensions.filter(isInstructions);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].name).toBe('sonar-prompt-secrets');
  });

  it('records only the hook extension when the instructions write was skipped (global instructions own the scope)', async () => {
    await updateCopilotState(PROJECT_ROOT, false, {
      hookInstalled: true,
      instructionsInstalled: false,
    });

    expect(state.agentExtensions.filter(isInstructions)).toHaveLength(0);
    const hooks = state.agentExtensions.filter(isHook);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe('sonar-secrets');
  });

  it('records nothing extension-wise when both writes were skipped, but still marks the agent configured', async () => {
    await updateCopilotState(PROJECT_ROOT, false, {
      hookInstalled: false,
      instructionsInstalled: false,
    });

    expect(state.agentExtensions).toHaveLength(0);
    expect(state.agents[COPILOT_AGENT_ID]?.configured).toBe(true);
  });

  it('marks extensions as global when isGlobal is true', async () => {
    await updateCopilotState(PROJECT_ROOT, true, {
      hookInstalled: true,
      instructionsInstalled: true,
    });

    expect(state.agentExtensions.every((e) => e.global === true)).toBe(true);
  });

  it('defaults both flags to false when no options are passed (records nothing)', async () => {
    await updateCopilotState(PROJECT_ROOT, false);

    expect(state.agentExtensions).toHaveLength(0);
    expect(state.agents[COPILOT_AGENT_ID]?.configured).toBe(true);
  });
});

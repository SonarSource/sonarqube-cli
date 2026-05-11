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
import { type CliState, getDefaultState } from '../../../../../../src/lib/state';

const COPILOT_AGENT_ID = 'copilot-cli';
const PROJECT_ROOT = '/project/root';

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

  it('defaults all flags to false when no options are passed (records nothing)', async () => {
    await updateCopilotState(PROJECT_ROOT, false);

    expect(state.agentExtensions).toHaveLength(0);
    expect(state.agents[COPILOT_AGENT_ID]?.configured).toBe(true);
  });

  it('records sonar-prompt-secrets at the run scope', async () => {
    await updateCopilotState(PROJECT_ROOT, false, { promptSecretsInstructionsInstalled: true });

    const promptSecrets = state.agentExtensions.find(
      (e) => e.kind === 'instructions' && e.name === 'sonar-prompt-secrets',
    );
    expect(promptSecrets).toBeDefined();
    expect(promptSecrets?.global).toBe(false);
    expect(promptSecrets?.projectRoot).toBe(PROJECT_ROOT);
  });

  it('records sonar-prompt-secrets as global when isGlobal is true', async () => {
    await updateCopilotState(PROJECT_ROOT, true, { promptSecretsInstructionsInstalled: true });

    const promptSecrets = state.agentExtensions.find(
      (e) => e.kind === 'instructions' && e.name === 'sonar-prompt-secrets',
    );
    expect(promptSecrets?.global).toBe(true);
  });

  it('records sonar-sqaa as project-scoped even when isGlobal is true, with cloud attrs', async () => {
    await updateCopilotState(PROJECT_ROOT, true, {
      sqaaInstructionsInstalled: true,
      projectKey: 'my-project',
      orgKey: 'my-org',
      serverUrl: 'https://sonarcloud.io',
    });

    const sqaa = state.agentExtensions.find(
      (e) => e.kind === 'instructions' && e.name === 'sonar-sqaa',
    );
    expect(sqaa).toBeDefined();
    expect(sqaa?.global).toBe(false);
    expect(sqaa?.projectRoot).toBe(PROJECT_ROOT);
    expect(sqaa?.projectKey).toBe('my-project');
    expect(sqaa?.orgKey).toBe('my-org');
    expect(sqaa?.serverUrl).toBe('https://sonarcloud.io');
  });
});

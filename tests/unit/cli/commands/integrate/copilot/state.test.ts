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

  it('defaults both flags to false when no options are passed (records nothing)', async () => {
    await updateCopilotState(PROJECT_ROOT, false);

    expect(state.agentExtensions).toHaveLength(0);
    expect(state.agents[COPILOT_AGENT_ID]?.configured).toBe(true);
  });
});

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

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import * as agentSessionStart from '@/commands/hook/agent-session-start.ts';

describe('codexSessionStart', () => {
  afterEach(() => {
    spyOn(agentSessionStart, 'handleAgentSessionStart').mockRestore();
  });

  it('delegates to handleAgentSessionStart with SessionStart', async () => {
    const spy = spyOn(agentSessionStart, 'handleAgentSessionStart').mockResolvedValue({
      agentSessionId: 's1',
    });

    const { codexSessionStart } = await import('@/commands/hook/codex-session-start.ts');
    const result = await codexSessionStart();

    expect(spy).toHaveBeenCalledWith('SessionStart');
    expect(result).toEqual({ agentSessionId: 's1' });
  });
});

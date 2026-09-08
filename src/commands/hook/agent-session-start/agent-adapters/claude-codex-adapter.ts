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

import type { SessionStartAgentAdapter } from '../types.ts';

interface ClaudeCodexSessionStartPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
}

export const claudeCodexAdapter: SessionStartAgentAdapter = {
  parse: (payload) => {
    const p = payload as ClaudeCodexSessionStartPayload;
    return { sessionId: p.session_id, startDir: p.cwd, eventName: p.hook_event_name };
  },
  emit: ({ additionalContext }, input) => ({
    hookSpecificOutput: { hookEventName: input.eventName, additionalContext },
  }),
};

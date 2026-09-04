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

// Per-agent input dialects and output envelopes for the session-start hook

import type { SessionStartAgent, SessionStartAgentAdapter } from './types.ts';

interface ClaudeCodexSessionStartPayload {
  session_id: string;
  cwd: string;
  hook_event_name: string;
}

const claudeCodexAdapter: SessionStartAgentAdapter = {
  parse: (payload) => {
    const p = payload as ClaudeCodexSessionStartPayload;
    return { sessionId: p.session_id, startDir: p.cwd, eventName: p.hook_event_name };
  },
  emit: ({ additionalContext }, input) => ({
    hookSpecificOutput: { hookEventName: input.eventName, additionalContext },
  }),
};

interface CopilotSessionStartPayload {
  sessionId: string;
  cwd: string;
}

const copilotAdapter: SessionStartAgentAdapter = {
  parse: (payload) => {
    const p = payload as CopilotSessionStartPayload;
    return { sessionId: p.sessionId, startDir: p.cwd, eventName: undefined };
  },
  emit: ({ additionalContext }) => ({ additionalContext }),
};

interface CursorSessionStartPayload {
  conversation_id: string;
  /** Normally one entry; a multiroot workspace has several, and the docs allow none. */
  workspace_roots: string[];
}

const cursorAdapter: SessionStartAgentAdapter = {
  parse: (payload) => {
    const p = payload as CursorSessionStartPayload;
    return { sessionId: p.conversation_id, startDir: p.workspace_roots[0], eventName: undefined };
  },
  emit: ({ additionalContext }) => ({ additional_context: additionalContext }),
};

const SESSION_START_ADAPTERS: Record<SessionStartAgent, SessionStartAgentAdapter> = {
  claude: claudeCodexAdapter,
  codex: claudeCodexAdapter,
  copilot: copilotAdapter,
  cursor: cursorAdapter,
};

export function resolveSessionStartAdapter(agent: string): SessionStartAgentAdapter | undefined {
  return SESSION_START_ADAPTERS[agent as SessionStartAgent];
}

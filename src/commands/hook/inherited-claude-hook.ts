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

import { hasCursorNativeHook } from '@/commands/integrate/cursor/declaration.ts';
import { hasDevinNativeHook } from '@/commands/integrate/devin/declaration.ts';
import { isCopilotCliAgentEnv, isDevinAgentEnv } from '@/core/host/environment/agent-detector.ts';

export function inheritedClaudeHookHost(payload: unknown): 'cursor' | 'devin' | null {
  if (
    payload &&
    typeof payload === 'object' &&
    'cursor_version' in payload &&
    typeof payload.cursor_version === 'string' &&
    payload.cursor_version &&
    'conversation_id' in payload &&
    typeof payload.conversation_id === 'string'
  ) {
    return 'cursor';
  }

  // Cursor also supplies CLAUDE_PROJECT_DIR for compatibility. A native Claude
  // marker may come from a nested session, so retain the check if both are present.
  if (
    process.env.CLAUDECODE === '1' ||
    process.env.CLAUDE_CODE_ENTRYPOINT ||
    isCopilotCliAgentEnv()
  )
    return null;
  const cursor = Boolean(process.env.CURSOR_VERSION && process.env.CURSOR_PROJECT_DIR);
  const devin = isDevinAgentEnv();
  if (cursor === devin) return null;
  return cursor ? 'cursor' : 'devin';
}

const CURSOR_EVENTS = {
  SessionStart: 'sessionStart',
  Stop: 'stop',
  PostToolUse: null,
  UserPromptSubmit: 'beforeSubmitPrompt',
} as const;

export async function shouldDeferClaudeHook(
  event: keyof typeof CURSOR_EVENTS,
  payload: unknown,
): Promise<boolean> {
  switch (inheritedClaudeHookHost(payload)) {
    case 'cursor': {
      const nativeEvent = CURSOR_EVENTS[event];
      return nativeEvent !== null && hasCursorNativeHook(nativeEvent);
    }
    case 'devin':
      return hasDevinNativeHook(event);
    case null:
      return false;
  }
}

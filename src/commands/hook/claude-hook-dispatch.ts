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

import logger from '@/core/observability/logger.ts';

import { writePostToolUseHookOutput } from './format-sqaa-hook-context.ts';

export interface ClaudePostToolUsePayload {
  tool_name?: string;
  tool_input?: { file_path?: string };
  tool_response?: unknown;
  session_id?: string;
}

/** `handled`: the subscriber already wrote its own hook JSON to stdout. */
export type ClaudePostToolUseResult =
  | { decision: 'context'; additionalContext: string }
  | { decision: 'handled' }
  | { decision: 'none' };

export interface ClaudePostToolUseSubscriber {
  id: string;
  matches: (toolName: string) => boolean;
  handle: (payload: ClaudePostToolUsePayload, rawStdin: string) => Promise<ClaudePostToolUseResult>;
}

export async function runClaudePostToolUseDispatch(
  payload: ClaudePostToolUsePayload,
  rawStdin: string,
  subscribers: ClaudePostToolUseSubscriber[],
): Promise<void> {
  const toolName = payload.tool_name;
  if (!toolName) {
    return;
  }

  const contexts: string[] = [];
  for (const subscriber of subscribers) {
    if (!subscriber.matches(toolName)) {
      continue;
    }
    const result = await subscriber.handle(payload, rawStdin);
    if (result.decision === 'context') {
      contexts.push(result.additionalContext);
    } else if (result.decision === 'handled') {
      if (contexts.length > 0) {
        logger.debug(
          `PostToolUse: discarding ${contexts.length} buffered context(s) — subscriber '${subscriber.id}' returned handled`,
        );
      }
      return;
    }
  }

  if (contexts.length === 0) {
    return;
  }

  try {
    writePostToolUseHookOutput(contexts.join('\n\n'));
  } catch (err) {
    logger.debug(`PostToolUse hook output failed: ${(err as Error).message}`);
  }
}

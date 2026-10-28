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

// Prepends the Vortex announcement to the task of Devin's `run_subagent` tool through `updatedInput`.

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import logger from '@/core/observability/logger.ts';

import { resolveSessionStartContext } from './agent-session-start/index.ts';
import type { HookCommandResult } from './hook-command-result.ts';
import { readStdinJson } from './stdin.ts';

interface RunSubagentPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  session_id?: string;
}

const RUN_SUBAGENT_TOOL = 'run_subagent';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function devinSubagentStart(
  ctx: CommandInvocationContext,
): Promise<HookCommandResult> {
  let payload: RunSubagentPayload;
  try {
    const parsed = await readStdinJson<unknown>();
    if (!isRecord(parsed)) return { agentSessionId: null };
    payload = parsed;
  } catch {
    return { agentSessionId: null };
  }

  const agentSessionId = payload.session_id ?? null;
  const toolInput = payload.tool_input;
  if (
    payload.tool_name !== RUN_SUBAGENT_TOOL ||
    !isRecord(toolInput) ||
    typeof toolInput.task !== 'string'
  ) {
    return { agentSessionId };
  }

  try {
    const announcement = await resolveSessionStartContext(ctx, {
      sessionId: agentSessionId ?? undefined,
      startDir: undefined,
      eventName: payload.hook_event_name,
    });
    const announcementText = announcement?.additionalContext.trimEnd();
    if (announcementText && !toolInput.task.startsWith(announcementText)) {
      const task = `${announcementText}\n\n${toolInput.task}`;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: { ...toolInput, task },
          },
        }) + '\n',
      );
    }
  } catch (err) {
    logger.debug(`devin-subagent-start failed: ${(err as Error).message}`);
  }
  return { agentSessionId };
}

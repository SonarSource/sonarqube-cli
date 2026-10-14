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

// PostToolUse handler for Devin — runs per-file SQAA after Devin's lowercase `edit`/`write` tools.

import { SQAA_DEVIN_POST_TOOL_USE_CALLER_COMMAND } from '@/commands/analyze/sqaa-analysis-telemetry.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import logger from '@/core/observability/logger.ts';

import { handleSqaaPostToolUse } from './agent-post-tool-use.ts';
import type { ClaudePostToolUsePayload } from './claude-hook-dispatch.ts';
import { writePostToolUseHookOutput } from './format-sqaa-hook-context.ts';
import type { HookCommandResult } from './hook-command-result.ts';
import { readStdinJson } from './stdin.ts';

// Devin tool names are lowercase and hook matching is case-sensitive.
const SQAA_TOOLS = new Set(['edit', 'write']);

export async function devinPostToolUse(ctx: CommandInvocationContext): Promise<HookCommandResult> {
  let payload: ClaudePostToolUsePayload;
  try {
    payload = await readStdinJson<ClaudePostToolUsePayload>();
  } catch {
    return { agentSessionId: null };
  }

  const agentSessionId = payload.session_id ?? null;
  if (!SQAA_TOOLS.has(payload.tool_name ?? '')) {
    return { agentSessionId };
  }

  try {
    const result = await handleSqaaPostToolUse(
      payload,
      ctx,
      SQAA_DEVIN_POST_TOOL_USE_CALLER_COMMAND,
    );
    if (result.decision === 'context') {
      writePostToolUseHookOutput(result.additionalContext);
    }
  } catch (err) {
    logger.debug(`devin-post-tool-use failed: ${(err as Error).message}`);
  }
  return { agentSessionId };
}

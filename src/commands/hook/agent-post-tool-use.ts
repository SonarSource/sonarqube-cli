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

// PostToolUse callback handler — runs SQAA analysis after the agent edits or writes a file.
// Registered as a subscriber on the shared PostToolUse dispatcher (claude-hook-dispatch.ts).

import {
  SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
  type SqaaTelemetryCallerCommand,
} from '@/commands/analyze/sqaa-analysis-telemetry.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';

import type {
  ClaudePostToolUsePayload,
  ClaudePostToolUseResult,
  ClaudePostToolUseSubscriber,
} from './claude-hook-dispatch.ts';
import { runClaudePostToolUseDispatch } from './claude-hook-dispatch.ts';
import { createContextAugmentationPostToolUseSubscriber } from './context-augmentation-hook-subscriber.ts';
import type { HookCommandResult } from './hook-command-result.ts';
import { analyzeEditedSqaaFile } from './sqaa-edited-file.ts';
import { readStdinJsonWithRaw } from './stdin.ts';
import { emitVortexUnavailableHookNotice } from './vortex-unavailable-hook-notice.ts';

export async function handleSqaaPostToolUse(
  payload: ClaudePostToolUsePayload,
  ctx: CommandInvocationContext,
  callerCommand: SqaaTelemetryCallerCommand,
): Promise<ClaudePostToolUseResult> {
  const filePath = payload.tool_input?.file_path;
  if (!filePath) return { decision: 'none' };
  const result = await analyzeEditedSqaaFile(filePath, ctx, callerCommand);
  if (!result) return { decision: 'none' };
  if (result.kind === 'forbidden') {
    const wrote = await emitVortexUnavailableHookNotice(result.connection);
    return { decision: wrote ? 'handled' : 'none' };
  }
  return { decision: 'context', additionalContext: result.context };
}

function createSqaaPostToolUseSubscriber(
  ctx: CommandInvocationContext,
): ClaudePostToolUseSubscriber {
  return {
    id: 'sqaa',
    matches: (toolName) => toolName === 'Edit' || toolName === 'Write',
    handle: (payload) =>
      handleSqaaPostToolUse(payload, ctx, SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND),
  };
}

export async function agentPostToolUse(ctx: CommandInvocationContext): Promise<HookCommandResult> {
  let raw: string;
  let payload: ClaudePostToolUsePayload;
  try {
    ({ raw, parsed: payload } = await readStdinJsonWithRaw<ClaudePostToolUsePayload>());
  } catch {
    return { agentSessionId: null }; // unparseable stdin — non-blocking
  }

  const fromHook = payload.session_id ?? null;

  await runClaudePostToolUseDispatch(payload, raw, [
    createSqaaPostToolUseSubscriber(ctx),
    createContextAugmentationPostToolUseSubscriber(ctx),
  ]);

  return { agentSessionId: fromHook };
}

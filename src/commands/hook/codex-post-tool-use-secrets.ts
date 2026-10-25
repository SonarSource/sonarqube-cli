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

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import {
  EXIT_CODE_SECRETS_FOUND,
  SECRETS_CALLER_COMMANDS,
  SECRETS_ERROR_SCANNING_TEMPLATE,
  SECRETS_NOTICE_BLOCKED_TEMPLATE,
  SECRETS_NOTICE_REDACTED,
} from '@/core/config-constants.ts';
import logger from '@/core/observability/logger.ts';

import { maskingDecision } from './agent-secrets-hooks.ts';
import type { HookCommandResult } from './hook-command-result.ts';
import { resolveAuthAndSecrets, runAndEmitTextSecretsScanWithIssues } from './hook-dependencies.ts';
import { readStdinJson } from './stdin.ts';

interface PostToolUsePayload {
  session_id?: string;
  tool_response?: unknown;
}

// Codex returns strings for shell/patch tools and objects for MCP.
// Clean results keep their original type; redaction replaces them with text feedback.
// https://learn.chatgpt.com/docs/hooks#posttooluse
function toolOutputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(toolOutputText).join('\n');
  if (value !== null && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entry]) => `${key}: ${toolOutputText(entry)}`)
      .join('\n');
  }
  return String(value);
}

function writeOutput(reason?: string): void {
  process.stdout.write(JSON.stringify(reason ? { decision: 'block', reason } : {}) + '\n');
}

function blockedMessage(reason: string): string {
  return SECRETS_NOTICE_BLOCKED_TEMPLATE.replace('{reason}', () => reason);
}

export async function codexPostToolUseSecrets(
  ctx: CommandInvocationContext,
): Promise<HookCommandResult> {
  let agentSessionId: string | null = null;
  try {
    const payload = await readStdinJson<PostToolUsePayload | null>().catch(() => null);
    agentSessionId = typeof payload?.session_id === 'string' ? payload.session_id : null;
    if (payload?.tool_response === undefined || payload.tool_response === null) {
      writeOutput();
      return { agentSessionId };
    }

    const toolOutput = toolOutputText(payload.tool_response);
    if (!toolOutput) {
      writeOutput();
      return { agentSessionId };
    }

    const deps = await resolveAuthAndSecrets(ctx);
    const { exitCode, issues } = await runAndEmitTextSecretsScanWithIssues(
      SECRETS_CALLER_COMMANDS.codexPostToolUseSecrets,
      deps,
      toolOutput,
      ctx,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      const decision = maskingDecision(toolOutput, issues);
      writeOutput(
        decision.block
          ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            blockedMessage(decision.reason!)
          : `${decision.redactedText}\n\n${SECRETS_NOTICE_REDACTED}`,
      );
    } else {
      writeOutput(
        exitCode === 0
          ? undefined
          : blockedMessage(
              SECRETS_ERROR_SCANNING_TEMPLATE.replace(
                '{reason}',
                () => `scanner exit code ${exitCode}`,
              ),
            ),
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.debug(`codex-post-tool-use-secrets secrets scan failed: ${reason}`);
    writeOutput(blockedMessage(SECRETS_ERROR_SCANNING_TEMPLATE.replace('{reason}', () => reason)));
  }
  return { agentSessionId };
}

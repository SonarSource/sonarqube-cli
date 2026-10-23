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

interface PromptTransformedPayload {
  transformedPrompt?: string;
  sessionId?: string;
}

function writeOutput(modifiedTransformedPrompt?: string): void {
  process.stdout.write(JSON.stringify({ modifiedTransformedPrompt }) + '\n');
}

function blockedMessage(reason: string): string {
  return SECRETS_NOTICE_BLOCKED_TEMPLATE.replace('{reason}', () => reason);
}

export async function copilotPromptTransformed(
  ctx: CommandInvocationContext,
): Promise<HookCommandResult> {
  let agentSessionId: string | null = null;
  try {
    const payload = await readStdinJson<PromptTransformedPayload | null>();
    agentSessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : null;
    const text = payload?.transformedPrompt;
    if (typeof text !== 'string' || !text) {
      writeOutput();
      return { agentSessionId };
    }

    const deps = await resolveAuthAndSecrets(ctx);
    const { exitCode, issues } = await runAndEmitTextSecretsScanWithIssues(
      SECRETS_CALLER_COMMANDS.copilotPromptTransformed,
      deps,
      text,
      ctx,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      const decision = maskingDecision(text, issues);
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
    logger.debug(`copilot-prompt-transformed secrets scan failed: ${reason}`);
    writeOutput(blockedMessage(SECRETS_ERROR_SCANNING_TEMPLATE.replace('{reason}', () => reason)));
  }
  return { agentSessionId };
}

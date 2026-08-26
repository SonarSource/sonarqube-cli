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

// beforeSubmitPrompt callback handler for Cursor — scans prompt text for secrets before it is sent.
//
// Cursor's beforeSubmitPrompt stdin payload exposes the user prompt at the same top-level `prompt`
// field as Claude and Codex, so the scanning core is shared. The block-output contract differs:
// Cursor expects `{ "continue": false, "user_message": "..." }` rather than Claude/Codex's
// `{ "decision": "block", "reason": "..." }`, which is why this handler is separate from
// `agentPromptSubmit`.

import type { CommandInvocationContext } from '@/commands/command-invocation-context.ts';
import logger from '@/core/observability/logger.ts';
import { SECRETS_CALLER_COMMANDS } from '@/commands/analyze/secrets-analysis-telemetry.ts';

import { EXIT_CODE_SECRETS_FOUND } from '../analyze/secrets.ts';
import type { HookCommandResult } from './hook-command-result.ts';
import {
  type HookDependencies,
  MissingDependenciesError,
  resolveAuthAndSecrets,
  runAndEmitTextSecretsScan,
} from './hook-dependencies.ts';
import { readStdinJson } from './stdin.ts';

interface CursorPromptSubmitPayload {
  prompt?: string;
  conversation_id?: string;
}

function denyPrompt(message: string): void {
  process.stdout.write(JSON.stringify({ continue: false, user_message: message }) + '\n');
}

export async function cursorPromptSubmit(
  ctx: CommandInvocationContext,
): Promise<HookCommandResult> {
  let payload: CursorPromptSubmitPayload;
  try {
    payload = await readStdinJson<CursorPromptSubmitPayload>();
  } catch (err) {
    logger.debug(`beforeSubmitPrompt: failed to parse stdin — ${(err as Error).message}`);
    return { agentSessionId: null }; // unparseable stdin — allow
  }

  const agentSessionId = payload.conversation_id ?? null;

  const prompt = payload.prompt;
  if (!prompt) return { agentSessionId };

  let deps: HookDependencies;
  try {
    deps = await resolveAuthAndSecrets();
  } catch (err) {
    if (err instanceof MissingDependenciesError) {
      denyPrompt(err.message);
      return { agentSessionId };
    }
    throw err;
  }

  try {
    const exitCode = await runAndEmitTextSecretsScan(
      SECRETS_CALLER_COMMANDS.cursorPromptSubmit,
      deps,
      prompt,
      ctx,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      denyPrompt('Sonar detected secrets in prompt');
    }
  } catch (err) {
    logger.debug(`beforeSubmitPrompt secrets scan failed: ${(err as Error).message}`);
  }

  return { agentSessionId };
}

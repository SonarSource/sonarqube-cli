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

// chat.message callback handler for OpenCode — scans one message part's text for secrets and,
// when any is found, returns a replacement text that masks the WHOLE message. The plugin swaps it
// into the part before the message is sent (and appends a synthetic reminder part so the model
// tells the user). The scanner's reported location can cover only part of a secret (a PEM key is
// located on its BEGIN line only), so masking just that span would leak the rest.
//
// Same explicit-JSON-always contract as `opencode-pre-tool-use` (see that file's comment).

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { EXIT_CODE_SECRETS_FOUND, SECRETS_CALLER_COMMANDS } from '@/core/config-constants.ts';
import logger from '@/core/observability/logger.ts';

import type { HookCommandResult } from './hook-command-result.ts';
import {
  type HookDependencies,
  MissingDependenciesError,
  resolveAuthAndSecrets,
  runAndEmitTextSecretsScan,
} from './hook-dependencies.ts';
import { readStdinJson } from './stdin.ts';

interface OpenCodeChatMessagePayload {
  text?: string;
  sessionID?: string;
}

export const OPENCODE_MASKED_MESSAGE_TEXT =
  '[Sonar] Message masked: secrets were detected, so the whole message was replaced and its original content was not sent.';

interface OpenCodeChatMessageDecision {
  block: boolean;
  reason?: string;
  redactedText?: string;
}

function writeDecision(decision: OpenCodeChatMessageDecision): void {
  process.stdout.write(JSON.stringify(decision) + '\n');
}

export async function opencodeChatMessage(
  ctx: CommandInvocationContext,
): Promise<HookCommandResult> {
  let payload: OpenCodeChatMessagePayload;
  try {
    payload = await readStdinJson<OpenCodeChatMessagePayload>();
  } catch {
    writeDecision({ block: false }); // unparseable stdin — allow
    return { agentSessionId: null };
  }

  const agentSessionId = payload.sessionID ?? null;

  const text = payload.text;
  if (!text) {
    writeDecision({ block: false });
    return { agentSessionId };
  }

  let deps: HookDependencies;
  try {
    deps = await resolveAuthAndSecrets(ctx);
  } catch (err) {
    if (err instanceof MissingDependenciesError) {
      writeDecision({ block: true, reason: err.message });
      return { agentSessionId };
    }
    throw err;
  }

  try {
    const exitCode = await runAndEmitTextSecretsScan(
      SECRETS_CALLER_COMMANDS.opencodeChatMessage,
      deps,
      text,
      ctx,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      writeDecision({ block: false, redactedText: OPENCODE_MASKED_MESSAGE_TEXT });
      return { agentSessionId };
    }
  } catch (err) {
    logger.debug(`opencode-chat-message secrets scan failed: ${(err as Error).message}`);
    writeDecision({
      block: true,
      reason: `SonarQube secret scanning failed unexpectedly: ${(err as Error).message}`,
    });
    return { agentSessionId };
  }

  writeDecision({ block: false });
  return { agentSessionId };
}

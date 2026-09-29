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
// if every finding can be masked, returns the text with each secret masked in place so the
// plugin can swap it into the part before the message is sent (the plugin also appends a
// synthetic reminder part so the model tells the user what was masked). Unlike
// `opencode-pre-tool-use`, this does not block on a well-formed finding — but if any finding
// can't be masked (missing location/mask, or an unparseable scan result), it fails closed and
// blocks the message rather than letting an unmasked secret through.
//
// Same explicit-JSON-always contract as `opencode-pre-tool-use` (see that file's comment).

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { EXIT_CODE_SECRETS_FOUND, SECRETS_CALLER_COMMANDS } from '@/core/config-constants.ts';
import logger from '@/core/observability/logger.ts';

import type { SecretsJsonIssue } from '../analyze/secrets.ts';
import type { HookCommandResult } from './hook-command-result.ts';
import {
  type HookDependencies,
  MissingDependenciesError,
  resolveAuthAndSecrets,
  runAndEmitTextSecretsScanWithIssues,
} from './hook-dependencies.ts';
import { readStdinJson } from './stdin.ts';

interface OpenCodeChatMessagePayload {
  text?: string;
  sessionID?: string;
}

interface OpenCodeChatMessageDecision {
  block: boolean;
  reason?: string;
  redactedText?: string;
  secretsFound?: number;
}

function writeDecision(decision: OpenCodeChatMessageDecision): void {
  process.stdout.write(JSON.stringify(decision) + '\n');
}

interface MaskableSpan {
  start: number;
  end: number;
  maskedSecret: string;
}

function toMaskableIssue(issue: SecretsJsonIssue, lineStarts: number[]): MaskableSpan | undefined {
  if (!issue.location || !issue.maskedSecret) return undefined;
  return {
    start: lineStarts[issue.location.startLine - 1] + issue.location.startColumn,
    end: lineStarts[issue.location.endLine - 1] + issue.location.endColumn,
    maskedSecret: issue.maskedSecret,
  };
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** Replaces each finding's span with its masked replacement, right-to-left by absolute offset
 * into the full text, so a multi-line secret (e.g. a PEM key) is masked across all of its lines
 * and earlier spans stay valid as later ones are spliced in. */
function redactSecrets(text: string, issues: MaskableSpan[]): string {
  const rightToLeft = [...issues].sort((a, b) => b.start - a.start);
  let out = text;
  for (const { start, end, maskedSecret } of rightToLeft) {
    out = out.slice(0, start) + maskedSecret + out.slice(end);
  }
  return out;
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
    const { exitCode, issues } = await runAndEmitTextSecretsScanWithIssues(
      SECRETS_CALLER_COMMANDS.opencodeChatMessage,
      deps,
      text,
      ctx,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      const lineStarts = lineStartOffsets(text);
      const maskable = issues
        .map((issue) => toMaskableIssue(issue, lineStarts))
        .filter((span): span is MaskableSpan => span !== undefined);
      if (issues.length === 0 || maskable.length !== issues.length) {
        writeDecision({
          block: true,
          reason: 'Sonar detected secrets in this message but could not mask all of them.',
        });
        return { agentSessionId };
      }
      writeDecision({
        block: false,
        redactedText: redactSecrets(text, maskable),
        secretsFound: issues.length,
      });
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

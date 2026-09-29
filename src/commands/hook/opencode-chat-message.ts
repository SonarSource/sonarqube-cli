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
// if any are found, returns the text with each secret masked in place so the plugin can swap it
// into the part before the message is sent. Unlike `opencode-pre-tool-use`, a found secret here
// does not block anything: the message still gets sent, just redacted (the plugin also appends a
// synthetic reminder part so the model tells the user what was masked).
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

/** Replaces each finding's span with its masked replacement, line by line, right-to-left per line
 * so earlier column offsets on the same line stay valid as later ones are spliced in. */
interface MaskableIssue {
  startLine: number;
  startColumn: number;
  endColumn: number;
  maskedSecret: string;
}

function toMaskableIssue(issue: SecretsJsonIssue): MaskableIssue | undefined {
  if (!issue.location || !issue.maskedSecret) return undefined;
  return {
    startLine: issue.location.startLine,
    startColumn: issue.location.startColumn,
    endColumn: issue.location.endColumn,
    maskedSecret: issue.maskedSecret,
  };
}

function redactSecrets(text: string, issues: SecretsJsonIssue[]): string {
  const lines = text.split('\n');
  const issuesByLine = new Map<number, MaskableIssue[]>();
  for (const issue of issues) {
    const maskable = toMaskableIssue(issue);
    if (!maskable) continue;
    const lineIndex = maskable.startLine - 1;
    const forLine = issuesByLine.get(lineIndex) ?? [];
    forLine.push(maskable);
    issuesByLine.set(lineIndex, forLine);
  }

  for (const [lineIndex, lineIssues] of issuesByLine) {
    let line = lines[lineIndex];
    const rightToLeft = [...lineIssues].sort((a, b) => b.startColumn - a.startColumn);
    for (const { startColumn, endColumn, maskedSecret } of rightToLeft) {
      line = line.slice(0, startColumn) + maskedSecret + line.slice(endColumn);
    }
    lines[lineIndex] = line;
  }
  return lines.join('\n');
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
    if (exitCode === EXIT_CODE_SECRETS_FOUND && issues.length > 0) {
      writeDecision({
        block: false,
        redactedText: redactSecrets(text, issues),
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

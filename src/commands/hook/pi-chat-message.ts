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

interface PiChatMessagePayload {
  text?: string;
  sessionID?: string;
}

interface PiChatMessageDecision {
  block: boolean;
  reason?: string;
  redactedText?: string;
  secretsFound?: number;
}

function writeDecision(decision: PiChatMessageDecision): void {
  process.stdout.write(JSON.stringify(decision) + '\n');
}

interface MaskableSpan {
  start: number;
  end: number;
  maskedSecret: string;
}

function toMaskableIssue(
  issue: SecretsJsonIssue,
  lineStarts: number[],
  textLength: number,
): MaskableSpan | undefined {
  if (!issue.location || !issue.maskedSecret) return undefined;
  const { startLine, endLine } = issue.location;
  if (startLine < 1 || startLine > lineStarts.length) return undefined;
  if (endLine < 1 || endLine > lineStarts.length) return undefined;
  const startLineOffset = lineStarts[startLine - 1];
  const endLineOffset = lineStarts[endLine - 1];
  const start = startLineOffset + issue.location.startColumn;
  const end = endLineOffset + issue.location.endColumn;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  if (start < 0 || end < start || end > textLength) return undefined;
  return { start, end, maskedSecret: issue.maskedSecret };
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function redactSecrets(text: string, issues: MaskableSpan[]): string {
  const rightToLeft = [...issues].sort((a, b) => b.start - a.start);
  let out = text;
  for (const { start, end, maskedSecret } of rightToLeft) {
    out = out.slice(0, start) + maskedSecret + out.slice(end);
  }
  return out;
}

export async function piChatMessage(ctx: CommandInvocationContext): Promise<HookCommandResult> {
  let payload: PiChatMessagePayload;
  try {
    payload = await readStdinJson<PiChatMessagePayload>();
  } catch {
    writeDecision({ block: false });
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
      SECRETS_CALLER_COMMANDS.piChatMessage,
      deps,
      text,
      ctx,
    );
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      const lineStarts = lineStartOffsets(text);
      const maskable = issues
        .map((issue) => toMaskableIssue(issue, lineStarts, text.length))
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
    if (exitCode !== 0) {
      writeDecision({
        block: true,
        reason: `SonarQube secret scanning failed (exit code ${exitCode}).`,
      });
      return { agentSessionId };
    }
  } catch (err) {
    logger.debug(`pi-chat-message secrets scan failed: ${(err as Error).message}`);
    writeDecision({
      block: true,
      reason: `SonarQube secret scanning failed unexpectedly: ${(err as Error).message}`,
    });
    return { agentSessionId };
  }

  writeDecision({ block: false });
  return { agentSessionId };
}

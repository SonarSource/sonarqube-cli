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

import { existsSync } from 'node:fs';

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { EXIT_CODE_SECRETS_FOUND, type SecretsCallerCommand } from '@/core/config-constants.ts';
import logger from '@/core/observability/logger.ts';

import type { SecretsJsonIssue } from '../analyze/secrets.ts';
import type { HookCommandResult } from './hook-command-result.ts';
import {
  type HookDependencies,
  MissingDependenciesError,
  resolveAuthAndSecrets,
  runAndEmitFileSecretsScan,
  runAndEmitTextSecretsScanWithIssues,
} from './hook-dependencies.ts';
import { readStdinJson } from './stdin.ts';

interface ChatMessagePayload {
  text?: string;
  sessionID?: string;
}

interface PreToolUsePayload {
  tool?: string;
  filePath?: string;
  sessionID?: string;
}

interface HookDecision {
  block: boolean;
  reason?: string;
  redactedText?: string;
  secretsFound?: number;
}

interface MaskableSpan {
  start: number;
  end: number;
  maskedSecret: string;
}

interface SecretsHookOptions {
  callerCommand: SecretsCallerCommand;
  logPrefix: string;
  blockOnUnexpectedExitCode: boolean;
}

interface PreToolUseHookOptions extends SecretsHookOptions {
  blockedFileReason: (filePath: string) => string;
}

function writeDecision(decision: HookDecision): void {
  process.stdout.write(JSON.stringify(decision) + '\n');
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

export function maskingDecision(text: string, issues: SecretsJsonIssue[]): HookDecision {
  const lineStarts = lineStartOffsets(text);
  const maskable = issues
    .map((issue) => toMaskableIssue(issue, lineStarts, text.length))
    .filter((span): span is MaskableSpan => span !== undefined);
  if (issues.length === 0 || maskable.length !== issues.length) {
    return {
      block: true,
      reason: 'SonarQube detected secrets in this message but could not mask all of them.',
    };
  }
  return {
    block: false,
    redactedText: redactSecrets(text, maskable),
    secretsFound: issues.length,
  };
}

async function resolveDependenciesOrBlock(
  ctx: CommandInvocationContext,
): Promise<HookDependencies | undefined> {
  try {
    return await resolveAuthAndSecrets(ctx);
  } catch (err) {
    if (err instanceof MissingDependenciesError) {
      writeDecision({ block: true, reason: err.message });
      return undefined;
    }
    throw err;
  }
}

function blockOnUnexpectedExitCode(options: SecretsHookOptions, exitCode: number): boolean {
  if (!options.blockOnUnexpectedExitCode || exitCode === 0) return false;
  writeDecision({
    block: true,
    reason: `SonarQube secret scanning failed (exit code ${exitCode}).`,
  });
  return true;
}

function blockOnScanFailure(options: SecretsHookOptions, err: unknown): void {
  const { message } = err as Error;
  logger.debug(`${options.logPrefix} secrets scan failed: ${message}`);
  writeDecision({
    block: true,
    reason: `SonarQube secret scanning failed unexpectedly: ${message}`,
  });
}

export function createChatMessageHook(
  options: SecretsHookOptions,
): (ctx: CommandInvocationContext) => Promise<HookCommandResult> {
  return async (ctx) => {
    let payload: ChatMessagePayload;
    try {
      payload = await readStdinJson<ChatMessagePayload>();
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

    const deps = await resolveDependenciesOrBlock(ctx);
    if (!deps) return { agentSessionId };

    try {
      const { exitCode, issues } = await runAndEmitTextSecretsScanWithIssues(
        options.callerCommand,
        deps,
        text,
        ctx,
      );
      if (exitCode === EXIT_CODE_SECRETS_FOUND) {
        writeDecision(maskingDecision(text, issues));
        return { agentSessionId };
      }
      if (blockOnUnexpectedExitCode(options, exitCode)) return { agentSessionId };
    } catch (err) {
      blockOnScanFailure(options, err);
      return { agentSessionId };
    }

    writeDecision({ block: false });
    return { agentSessionId };
  };
}

export function createPreToolUseHook(
  options: PreToolUseHookOptions,
): (ctx: CommandInvocationContext) => Promise<HookCommandResult> {
  return async (ctx) => {
    let payload: PreToolUsePayload;
    try {
      payload = await readStdinJson<PreToolUsePayload>();
    } catch {
      writeDecision({ block: false }); // unparseable stdin — allow
      return { agentSessionId: null };
    }

    const agentSessionId = payload.sessionID ?? null;

    if (payload.tool !== 'read') {
      writeDecision({ block: false });
      return { agentSessionId };
    }

    const filePath = payload.filePath;
    if (!filePath || !existsSync(filePath)) {
      writeDecision({ block: false });
      return { agentSessionId };
    }

    const deps = await resolveDependenciesOrBlock(ctx);
    if (!deps) return { agentSessionId };

    try {
      const exitCode = await runAndEmitFileSecretsScan(options.callerCommand, deps, filePath, ctx);
      if (exitCode === EXIT_CODE_SECRETS_FOUND) {
        writeDecision({ block: true, reason: options.blockedFileReason(filePath) });
        return { agentSessionId };
      }
      if (blockOnUnexpectedExitCode(options, exitCode)) return { agentSessionId };
    } catch (err) {
      blockOnScanFailure(options, err);
      return { agentSessionId };
    }

    writeDecision({ block: false });
    return { agentSessionId };
  };
}

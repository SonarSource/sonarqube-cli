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

import { existsSync, readFileSync } from 'node:fs';

import { AGENTIC_PACK_URL } from '@/core/config-constants.ts';
import { resolveAuth } from '@/core/host/auth-resolver.ts';
import { canonicalizePath, toRelativePosixPath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import { timed } from '@/core/observability/timed.ts';
import { SqaaForbiddenError } from '@/core/server/errors.ts';
import {
  emitSqaaHookFailureTelemetry,
  SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
  SQAA_HOOK_TELEMETRY_EXIT_CODE,
} from '@/core/telemetry/sqaa-analysis-telemetry.ts';

import { resolveSqaaBranch } from '../analyze/sqaa-changeset.ts';
import { fetchSingleFileReport, finishSqaaTelemetryFromReport } from '../analyze/sqaa-run.ts';
import type {
  ClaudePostToolUsePayload,
  ClaudePostToolUseResult,
  ClaudePostToolUseSubscriber,
} from './claude-hook-dispatch.ts';
import { runClaudePostToolUseDispatch } from './claude-hook-dispatch.ts';
import { contextAugmentationPostToolUseSubscriber } from './context-augmentation-hook-subscriber.ts';
import { formatSqaaIssuesForHook } from './format-sqaa-hook-context.ts';
import { readStdinJsonWithRaw } from './stdin.ts';

export interface AgentPostToolUseOptions {
  project?: string;
}

const CLAUDE_HOOK_TELEMETRY_OPTIONS = {
  telemetryCallerCommand: SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
  telemetryProcessExitCode: SQAA_HOOK_TELEMETRY_EXIT_CODE,
} as const;

async function handleSqaaPostToolUse(
  payload: ClaudePostToolUsePayload,
  projectKey: string | undefined,
): Promise<ClaudePostToolUseResult> {
  const filePath = payload.tool_input?.file_path;
  if (!filePath || !existsSync(filePath)) {
    return { decision: 'none' };
  }

  const auth = await resolveAuth().catch(() => null);
  if (auth?.connectionType !== 'cloud') {
    return { decision: 'none' };
  }

  const orgKey = auth.orgKey;
  if (!orgKey || !projectKey) {
    return { decision: 'none' };
  }

  const canonicalPath = canonicalizePath(filePath);
  const normalizedPath = toRelativePosixPath(canonicalPath);
  if (normalizedPath == null) {
    logger.debug(`PostToolUse SQAA skipped: file outside cwd: ${filePath}`);
    return { decision: 'none' };
  }

  const runStart = performance.now();
  let fetchResult: Awaited<ReturnType<typeof fetchSingleFileReport>>;
  try {
    const fileContent = readFileSync(canonicalPath, 'utf-8');
    const cloudAuth = { serverUrl: auth.serverUrl, token: auth.token, orgKey };
    const branch = await resolveSqaaBranch(undefined, canonicalPath);

    const timedFetch = await timed(() =>
      fetchSingleFileReport(
        cloudAuth,
        projectKey,
        canonicalPath,
        fileContent,
        branch,
        undefined,
        'STANDARD',
      ),
    );
    fetchResult = timedFetch.result;

    await finishSqaaTelemetryFromReport(
      fetchResult.report,
      auth,
      CLAUDE_HOOK_TELEMETRY_OPTIONS,
      timedFetch.durationMs,
    ).catch(() => undefined);
  } catch (err) {
    await emitSqaaHookFailureTelemetry(
      SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
      auth,
      Math.round(performance.now() - runStart),
    ).catch(() => undefined);
    logger.debug(`PostToolUse SQAA analysis failed: ${(err as Error).message}`);
    return { decision: 'none' };
  }

  if (fetchResult.error) {
    if (fetchResult.error instanceof SqaaForbiddenError) {
      return {
        decision: 'context',
        additionalContext: `Run \`sonar integrate\` to uninstall unavailable hooks. See ${AGENTIC_PACK_URL}`,
      };
    }
    logger.debug(`PostToolUse SQAA analysis failed: ${fetchResult.error.message}`);
    return { decision: 'none' };
  }

  try {
    const file = fetchResult.report.files[0];
    const text = formatSqaaIssuesForHook(file.issues, file.errors, normalizedPath);
    return { decision: 'context', additionalContext: text };
  } catch (err) {
    logger.debug(`PostToolUse SQAA hook output failed: ${(err as Error).message}`);
    return { decision: 'none' };
  }
}

function createSqaaPostToolUseSubscriber(
  projectKey: string | undefined,
): ClaudePostToolUseSubscriber {
  return {
    id: 'sqaa',
    matches: (toolName) => toolName === 'Edit' || toolName === 'Write',
    handle: (payload) => handleSqaaPostToolUse(payload, projectKey),
  };
}

export async function agentPostToolUse(options: AgentPostToolUseOptions): Promise<void> {
  let raw: string;
  let payload: ClaudePostToolUsePayload;
  try {
    ({ raw, parsed: payload } = await readStdinJsonWithRaw<ClaudePostToolUsePayload>());
  } catch {
    return; // unparseable stdin — non-blocking
  }

  await runClaudePostToolUseDispatch(payload, raw, [
    createSqaaPostToolUseSubscriber(options.project),
    contextAugmentationPostToolUseSubscriber,
  ]);
}

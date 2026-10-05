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

import { existsSync, readFileSync } from 'node:fs';

import {
  recordSqaaAnalysisTelemetry,
  SQAA_HOOK_TELEMETRY_EXIT_CODE,
  SQAA_OPENCODE_POST_TOOL_USE_CALLER_COMMAND,
} from '@/commands/analyze/sqaa-analysis-telemetry.ts';
import { isSonarQubeCloud } from '@/core/auth/auth-resolver.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { canonicalizePath, toRelativePosixPath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import { timed } from '@/core/observability/timed.ts';
import { discoverProject } from '@/core/project-info.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { SqaaForbiddenError } from '@/core/server/errors.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { vortexUnavailableHookMessage } from '@/core/vortex/availability-messages.ts';
import { recheckVortexEntitlement } from '@/core/vortex/entitlement.ts';
import {
  isVortexEntitlementLossNoticeDue,
  recordVortexEntitlementLossWarned,
} from '@/core/vortex/vortex-entitlement-notice.ts';

import { resolveSqaaBranch } from '../analyze/sqaa-changeset.ts';
import { fetchSingleFileReport, finishSqaaTelemetryFromReport } from '../analyze/sqaa-run.ts';
import { formatSqaaIssuesForHook } from './format-sqaa-hook-context.ts';
import type { HookCommandResult } from './hook-command-result.ts';
import { readStdinJson } from './stdin.ts';

const SQAA_TOOLS = new Set(['edit', 'write']);

interface OpenCodePostToolUsePayload {
  tool?: string;
  filePath?: string;
  sessionID?: string;
}

interface OpenCodePostToolUseResult {
  context?: string;
}

function writeResult(result: OpenCodePostToolUseResult): void {
  process.stdout.write(JSON.stringify(result) + '\n');
}

async function resolveVortexUnavailableNotice(
  connection: SonarConnection,
): Promise<string | undefined> {
  if (!isVortexEntitlementLossNoticeDue()) {
    return undefined;
  }
  const status = await recheckVortexEntitlement(connection);
  const message = vortexUnavailableHookMessage(status);
  if (!message) {
    return undefined;
  }
  if (status === 'not_entitled') {
    recordVortexEntitlementLossWarned();
  }
  return message;
}

async function analyzeEditedFile(
  filePath: string,
  ctx: CommandInvocationContext,
): Promise<string | undefined> {
  const connection = await ctx.resolveConnection();
  if (!connection) {
    return undefined;
  }
  const { auth } = connection;

  if (isSonarQubeCloud(auth.serverUrl) && !auth.orgKey) {
    return undefined;
  }

  const { projectKey } = await discoverProject(process.cwd(), {
    auth,
    silent: true,
    console: ctx.console,
  });
  if (!projectKey) {
    return undefined;
  }

  noteProject(auth, projectKey);

  const canonicalPath = canonicalizePath(filePath);
  const normalizedPath = toRelativePosixPath(canonicalPath);
  if (normalizedPath == null) {
    logger.debug(`opencode-post-tool-use SQAA skipped: file outside cwd: ${filePath}`);
    return undefined;
  }

  const runStart = performance.now();
  let fetchResult: Awaited<ReturnType<typeof fetchSingleFileReport>>;
  try {
    const fileContent = readFileSync(canonicalPath, 'utf-8');
    const branch = await resolveSqaaBranch(undefined, canonicalPath);

    const timedFetch = await timed(() =>
      fetchSingleFileReport(
        connection,
        projectKey,
        canonicalPath,
        fileContent,
        branch,
        undefined,
        'STANDARD',
      ),
    );
    fetchResult = timedFetch.result;

    finishSqaaTelemetryFromReport(
      fetchResult.report,
      {
        telemetryCallerCommand: SQAA_OPENCODE_POST_TOOL_USE_CALLER_COMMAND,
        telemetryProcessExitCode: SQAA_HOOK_TELEMETRY_EXIT_CODE,
        telemetryCtx: ctx,
        auth,
      },
      timedFetch.durationMs,
    );
  } catch (err) {
    recordSqaaAnalysisTelemetry(
      ctx,
      auth,
      SQAA_OPENCODE_POST_TOOL_USE_CALLER_COMMAND,
      { allResults: [], totalIssues: 0, totalErrors: 0, totalFailures: 1 },
      Math.round(performance.now() - runStart),
      SQAA_HOOK_TELEMETRY_EXIT_CODE,
    );
    logger.debug(`opencode-post-tool-use SQAA analysis failed: ${(err as Error).message}`);
    return undefined;
  }

  if (fetchResult.error) {
    if (fetchResult.error instanceof SqaaForbiddenError) {
      return resolveVortexUnavailableNotice(connection);
    }
    logger.debug(`opencode-post-tool-use SQAA analysis failed: ${fetchResult.error.message}`);
    return undefined;
  }

  const file = fetchResult.report.files[0];
  return formatSqaaIssuesForHook(file.issues, file.errors, normalizedPath);
}

export async function opencodePostToolUse(
  ctx: CommandInvocationContext,
): Promise<HookCommandResult> {
  let payload: OpenCodePostToolUsePayload;
  try {
    payload = await readStdinJson<OpenCodePostToolUsePayload>();
  } catch {
    writeResult({});
    return { agentSessionId: null };
  }

  const agentSessionId = payload.sessionID ?? null;
  const filePath = payload.filePath;

  if (!SQAA_TOOLS.has(payload.tool ?? '') || !filePath || !existsSync(filePath)) {
    writeResult({});
    return { agentSessionId };
  }

  try {
    const context = await analyzeEditedFile(filePath, ctx);
    writeResult(context === undefined ? {} : { context });
  } catch (err) {
    logger.debug(`opencode-post-tool-use failed: ${(err as Error).message}`);
    writeResult({});
  }
  return { agentSessionId };
}

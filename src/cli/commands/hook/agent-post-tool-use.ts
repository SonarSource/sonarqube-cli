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
// Replaces the bash/PowerShell logic that was previously embedded in the hook script.

import { existsSync, readFileSync } from 'node:fs';

import { resolveAuth } from '../../../lib/auth-resolver';
import { canonicalizePath, toRelativePosixPath } from '../../../lib/fs-utils';
import logger from '../../../lib/logger';
import { timed } from '../../../lib/timed.js';
import {
  emitSqaaHookFailureTelemetry,
  SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
  SQAA_HOOK_TELEMETRY_EXIT_CODE,
} from '../../../telemetry/sqaa-analysis-telemetry.js';
import { fetchSingleFileReport, finishSqaaTelemetryFromReport } from '../analyze/sqaa-run.js';
import { formatSqaaIssuesForHook, writePostToolUseHookOutput } from './format-sqaa-hook-context';
import { readStdinJson } from './stdin';

interface PostToolUsePayload {
  tool_name?: string;
  tool_input?: { file_path?: string };
}

export interface AgentPostToolUseOptions {
  project?: string;
}

const CLAUDE_HOOK_TELEMETRY_OPTIONS = {
  telemetryCallerCommand: SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
  telemetryProcessExitCode: SQAA_HOOK_TELEMETRY_EXIT_CODE,
} as const;

export async function agentPostToolUse(options: AgentPostToolUseOptions): Promise<void> {
  let payload: PostToolUsePayload;
  try {
    payload = await readStdinJson<PostToolUsePayload>();
  } catch {
    return; // unparseable stdin — non-blocking
  }

  const toolName = payload.tool_name;
  if (toolName !== 'Edit' && toolName !== 'Write') return;

  const filePath = payload.tool_input?.file_path;
  if (!filePath || !existsSync(filePath)) return;

  const auth = await resolveAuth().catch(() => null);
  if (auth?.connectionType !== 'cloud') return;

  const orgKey = auth.orgKey;
  if (!orgKey) return;

  const projectKey = options.project;
  if (!projectKey) return;

  const canonicalPath = canonicalizePath(filePath);
  const normalizedPath = toRelativePosixPath(canonicalPath);
  if (normalizedPath == null) {
    logger.debug(`PostToolUse SQAA skipped: file outside cwd: ${filePath}`);
    return;
  }

  const runStart = performance.now();
  let fetchResult: Awaited<ReturnType<typeof fetchSingleFileReport>>;
  try {
    const fileContent = readFileSync(canonicalPath, 'utf-8');
    const cloudAuth = { serverUrl: auth.serverUrl, token: auth.token, orgKey };

    const timedFetch = await timed(() =>
      fetchSingleFileReport(
        cloudAuth,
        projectKey,
        canonicalPath,
        fileContent,
        undefined,
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
    );
  } catch (err) {
    await emitSqaaHookFailureTelemetry(
      SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND,
      auth,
      Math.round(performance.now() - runStart),
    );
    logger.debug(`PostToolUse SQAA analysis failed: ${(err as Error).message}`);
    return;
  }

  if (fetchResult.error) {
    logger.debug(`PostToolUse SQAA analysis failed: ${fetchResult.error.message}`);
    return;
  }

  try {
    const file = fetchResult.report.files[0];
    const text = formatSqaaIssuesForHook(file.issues, file.errors, normalizedPath);
    writePostToolUseHookOutput(text);
  } catch (err) {
    logger.debug(`PostToolUse SQAA hook output failed: ${(err as Error).message}`);
  }
}

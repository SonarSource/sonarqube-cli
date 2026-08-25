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

// PostToolUse callback handler for Codex — runs git change-set SQAA after apply_patch.

import { buildSqaaJsonReport } from '@/commands/analyze/sqaa.ts';
import type { SqaaJsonReport } from '@/commands/analyze/sqaa-display.ts';
import { resolveAuth } from '@/core/auth/auth-resolver.ts';
import logger from '@/core/observability/logger.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import {
  emitSqaaHookFailureTelemetry,
  SQAA_CODEX_POST_TOOL_USE_CALLER_COMMAND,
  SQAA_HOOK_TELEMETRY_EXIT_CODE,
} from '@/core/telemetry/sqaa-analysis-telemetry.ts';

import {
  formatSqaaJsonReportForHook,
  writePostToolUseHookOutput,
} from './format-sqaa-hook-context.ts';
import type { HookCommandResult } from './hook-command-result.ts';
import { readStdinJson } from './stdin.ts';
import { emitVortexUnavailableHookNotice } from './vortex-unavailable-hook-notice.ts';

export interface CodexPostToolUseOptions {
  project?: string;
}

const CODEX_HOOK_TELEMETRY_OPTIONS = {
  telemetryCallerCommand: SQAA_CODEX_POST_TOOL_USE_CALLER_COMMAND,
  telemetryProcessExitCode: SQAA_HOOK_TELEMETRY_EXIT_CODE,
} as const;

interface CodexPostToolUsePayload {
  session_id?: string;
}

export async function codexPostToolUse(
  options: CodexPostToolUseOptions,
): Promise<HookCommandResult> {
  // Best-effort: when Codex pipes PostToolUse JSON, capture session_id. Skip when
  // stdin is a TTY — otherwise readStdinJson waits up to 5s for data that never
  // arrives. Env-based CODEX_* ids still resolve later via resolveAgentSessionId.
  let agentSessionId: string | null = null;
  if (!process.stdin.isTTY) {
    try {
      const payload = await readStdinJson<CodexPostToolUsePayload>();
      agentSessionId = payload.session_id ?? null;
    } catch {
      // ignore
    }
  }

  const projectKey = options.project;
  if (!projectKey) return { agentSessionId };

  const auth = await resolveAuth().catch(() => null);
  if (auth?.connectionType !== 'cloud' || !auth.orgKey) return { agentSessionId };

  noteProject(auth, projectKey);

  const runStart = performance.now();
  let report: SqaaJsonReport | null;
  try {
    report = await buildSqaaJsonReport(
      { project: projectKey, force: true, format: 'json', forcedDepth: 'STANDARD' },
      auth,
      CODEX_HOOK_TELEMETRY_OPTIONS,
    );
  } catch (err) {
    await emitSqaaHookFailureTelemetry(
      SQAA_CODEX_POST_TOOL_USE_CALLER_COMMAND,
      auth,
      Math.round(performance.now() - runStart),
    ).catch(() => undefined);
    logger.debug(`Codex PostToolUse SQAA analysis failed: ${(err as Error).message}`);
    return { agentSessionId };
  }

  if (!report) return { agentSessionId };

  if (report.globalError?.kind === 'forbidden') {
    await emitVortexUnavailableHookNotice(auth);
    return { agentSessionId };
  }

  try {
    const text = formatSqaaJsonReportForHook(report);
    if (text) {
      writePostToolUseHookOutput(text);
    }
  } catch (err) {
    logger.debug(`Codex PostToolUse SQAA hook output failed: ${(err as Error).message}`);
  }

  return { agentSessionId };
}

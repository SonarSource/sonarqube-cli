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

import { randomUUID } from 'node:crypto';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import type { SqaaIssue } from '@/core/server/client.ts';
import { emitTelemetryEvent } from '@/core/telemetry/telemetry-events.ts';

import { type AnalysisCompletedPayload,CLI_ANALYSIS_COMPLETED } from './analysis-completed.ts';
import type { FileResult, RunTally } from './sqaa-analysis.ts';
import type { SqaaJsonReport } from './sqaa-display-json.ts';

export const SQAA_ANALYZE_CALLER_COMMAND = 'analyze';

export const SQAA_ANALYZE_AGENTIC_CALLER_COMMAND = 'analyze agentic';

export const SQAA_VERIFY_CALLER_COMMAND = 'verify';

export const SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND = 'claude-post-tool-use';

export const SQAA_CODEX_POST_TOOL_USE_CALLER_COMMAND = 'codex-post-tool-use';

export type SqaaTelemetryCallerCommand =
  | typeof SQAA_ANALYZE_CALLER_COMMAND
  | typeof SQAA_ANALYZE_AGENTIC_CALLER_COMMAND
  | typeof SQAA_VERIFY_CALLER_COMMAND
  | typeof SQAA_CLAUDE_POST_TOOL_USE_CALLER_COMMAND
  | typeof SQAA_CODEX_POST_TOOL_USE_CALLER_COMMAND;

/**
 * PostToolUse SQAA hooks are non-blocking (process always exits 0). Telemetry should
 * record that real exit, not the would-be CLI exit. Use findings_count, errors_count,
 * and failures_count for analysis outcomes.
 */
export const SQAA_HOOK_TELEMETRY_EXIT_CODE = 0;

/**
 * Emits CliAnalysisCompleted for a hook run that failed before or during analysis
 * (e.g. buildSqaaJsonReport threw). Uses {@link SQAA_HOOK_TELEMETRY_EXIT_CODE} because
 * hooks never block the agent process.
 */
export async function emitSqaaHookFailureTelemetry(
  callerCommand: SqaaTelemetryCallerCommand,
  auth: ResolvedAuth,
  durationMs: number,
  agentSessionId?: string | null,
): Promise<void> {
  await emitSqaaAnalysisTelemetry(
    callerCommand,
    auth,
    { allResults: [], totalIssues: 0, totalErrors: 0, totalFailures: 1 },
    durationMs,
    SQAA_HOOK_TELEMETRY_EXIT_CODE,
    agentSessionId,
  );
}

export interface SqaaRuleCountsDetails {
  rule_keys: string[];
  counts_by_rule: Record<string, number>;
}

export function collectRuleCounts(
  issues: ReadonlyArray<Pick<SqaaIssue, 'rule'>>,
): SqaaRuleCountsDetails {
  const countsByRule: Record<string, number> = {};
  for (const issue of issues) {
    countsByRule[issue.rule] = (countsByRule[issue.rule] ?? 0) + 1;
  }
  return {
    rule_keys: Object.keys(countsByRule).sort((a, b) => a.localeCompare(b)),
    counts_by_rule: countsByRule,
  };
}

function collectIssuesFromTally(tally: RunTally): SqaaIssue[] {
  const issues: SqaaIssue[] = [];
  for (const result of tally.allResults) {
    if ('failure' in result) continue;
    issues.push(...result.issues);
  }
  return issues;
}

/** Builds a RunTally from a SQAA JSON report (change-set / Codex hook path). */
export function tallyFromSqaaJsonReport(report: SqaaJsonReport): RunTally {
  const allResults: FileResult[] = [];

  for (const file of report.files) {
    allResults.push({
      file: file.path,
      filePath: file.path,
      issues: file.issues,
      errors: file.errors,
    });
  }

  for (const failure of report.failures) {
    allResults.push({
      file: failure.path,
      filePath: failure.path,
      failure: new Error(failure.message),
    });
  }

  const totalErrors = report.files.reduce((count, file) => count + (file.errors?.length ?? 0), 0);

  return {
    allResults,
    totalIssues: report.summary.totalIssues,
    totalErrors,
    totalFailures: report.summary.totalFailures,
  };
}

/**
 * Emits a single CliAnalysisCompleted event for one SQAA run, carrying `details`
 * (JSON-encoded blob when issues exist, `""` otherwise). No-ops when telemetry is disabled.
 *
 * Pass `exitCode` from the command handler. Omit or pass `null` when the invocation has no exit.
 * PostToolUse hooks pass {@link SQAA_HOOK_TELEMETRY_EXIT_CODE} (always 0) because they never
 * set `process.exitCode`; use counts fields for analysis outcomes.
 *
 * `errors_count` is {@link RunTally.totalErrors} only (API `errors[]` on successful analyses).
 * `failures_count` is {@link RunTally.totalFailures} (per-file analysis failures).
 *
 * The body is fully guarded, matching {@link emitScaAnalysisTelemetry}: this was the only
 * `emit*` path with no exception handling anywhere in its call chain, so a throw from identity
 * resolution or the event file write could turn a successful SQAA analysis into a reported
 * command failure. Telemetry is strictly fire-and-forget.
 */
export async function emitSqaaAnalysisTelemetry(
  callerCommand: SqaaTelemetryCallerCommand,
  auth: ResolvedAuth,
  tally: RunTally,
  durationMs: number,
  exitCode?: number | null,
  agentSessionId?: string | null,
): Promise<void> {
  try {
    const analysisId = randomUUID();
    const findingsCount = tally.totalIssues;
    const details =
      findingsCount > 0 ? JSON.stringify(collectRuleCounts(collectIssuesFromTally(tally))) : '';

    await emitTelemetryEvent(
      CLI_ANALYSIS_COMPLETED,
      {
        caller_command: callerCommand,
        analyzer: 'sqaa',
        analysis_id: analysisId,
        findings_count: findingsCount,
        exit_code: exitCode ?? null,
        errors_count: tally.totalErrors,
        failures_count: tally.totalFailures,
        scan_duration_ms: durationMs,
        details,
      } satisfies AnalysisCompletedPayload,
      { auth, agentSessionId },
    );
  } catch {
    // Telemetry is strictly fire-and-forget; never surface to the command handler.
  }
}

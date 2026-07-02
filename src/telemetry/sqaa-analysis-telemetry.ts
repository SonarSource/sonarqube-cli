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

import type { FileResult, RunTally } from '../cli/commands/analyze/sqaa-analysis.js';
import type { SqaaJsonReport } from '../cli/commands/analyze/sqaa-display-json.js';
import type { ResolvedAuth } from '../lib/auth-resolver.js';
import type { SqaaIssue } from '../sonarqube/client.js';
import { emitAnalysisCompleted, emitAnalysisFindingsDetected } from './findings.js';

export const SQAA_DETAILS_SCHEMA_VERSION = 1;

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
): Promise<void> {
  await emitSqaaAnalysisTelemetry(
    callerCommand,
    auth,
    { allResults: [], totalIssues: 0, totalErrors: 0, totalFailures: 1 },
    durationMs,
    SQAA_HOOK_TELEMETRY_EXIT_CODE,
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

/** Builds a RunTally from a single-file SQAA API response (PostToolUse hook path). */
export function tallyFromSqaaResponse(
  filePath: string,
  issues: SqaaIssue[],
  errors?: Array<{ code: string; message: string }> | null,
): RunTally {
  const allResults: FileResult[] = [
    {
      file: filePath,
      filePath,
      issues,
      errors,
    },
  ];
  return {
    allResults,
    totalIssues: issues.length,
    totalErrors: errors?.length ?? 0,
    totalFailures: 0,
  };
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
 * Emits CliAnalysisCompleted (always) and CliAnalysisFindingsDetected (when issues exist)
 * for one SQAA run. No-ops when telemetry is disabled.
 *
 * Pass `exitCode` from the command handler. Omit or pass `null` when the invocation has no exit.
 * PostToolUse hooks pass {@link SQAA_HOOK_TELEMETRY_EXIT_CODE} (always 0) because they never
 * set `process.exitCode`; use counts fields for analysis outcomes.
 *
 * `errors_count` is {@link RunTally.totalErrors} only (API `errors[]` on successful analyses).
 * `failures_count` is {@link RunTally.totalFailures} (per-file analysis failures).
 */
export async function emitSqaaAnalysisTelemetry(
  callerCommand: SqaaTelemetryCallerCommand,
  auth: ResolvedAuth,
  tally: RunTally,
  durationMs: number,
  exitCode?: number | null,
): Promise<void> {
  const analysisId = randomUUID();
  const findingsCount = tally.totalIssues;

  await emitAnalysisCompleted(auth, {
    caller_command: callerCommand,
    analyzer: 'sqaa',
    analysis_id: analysisId,
    findings_count: findingsCount,
    exit_code: exitCode ?? null,
    errors_count: tally.totalErrors,
    failures_count: tally.totalFailures,
    scan_duration_ms: durationMs,
  });

  if (findingsCount === 0) return;

  await emitAnalysisFindingsDetected(auth, {
    caller_command: callerCommand,
    analyzer: 'sqaa',
    analysis_id: analysisId,
    details_schema_version: SQAA_DETAILS_SCHEMA_VERSION,
    details: JSON.stringify(collectRuleCounts(collectIssuesFromTally(tally))),
  });
}

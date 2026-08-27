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
import { emitTelemetryEvent } from '@/core/telemetry/telemetry-events.ts';

import { type AnalysisCompletedPayload, CLI_ANALYSIS_COMPLETED } from './analysis-completed.ts';
import type { AnalyzeProjectResponse } from './dependency-risk-helpers/sca-scanner.ts';

/**
 * The `caller_command` value recorded on every SCA analysis event, one per call site.
 * `gitPreCommit` matches the sonar-secrets stage of the same hook (SECRETS_CALLER_COMMANDS);
 * the two stages are distinguished by `analyzer`, not `caller_command`.
 */
export const SCA_CALLER_COMMANDS = {
  analyzeDependencyRisks: 'analyze dependency-risks',
  gitPreCommit: 'git-pre-commit',
} as const;

/** Union of the valid SCA `caller_command` values. */
export type ScaCallerCommand = (typeof SCA_CALLER_COMMANDS)[keyof typeof SCA_CALLER_COMMANDS];

/** Allowlisted, privacy-safe details blob: per-`<type>:<severity>` counts only. */
export interface ScaFindingsDetails {
  counts_by_rule: Record<string, number>;
}

/**
 * Pure summariser of a successful SCA response. Counts only issues on newly-introduced
 * releases (`AnalyzeProjectRelease.newlyIntroduced === true`) — pre-existing releases are
 * excluded from both the count and the details blob. Keys are raw-enum `<ScaIssueType>:<Severity>`
 * composites (e.g. `VULNERABILITY:HIGH`); no rule keys, paths, or free-form text.
 */
export function summarizeScaFindings(response: AnalyzeProjectResponse): {
  findingsCount: number;
  details: ScaFindingsDetails;
} {
  const countsByRule: Record<string, number> = {};
  let findingsCount = 0;
  for (const release of response.releases) {
    if (!release.newlyIntroduced) continue;
    for (const issue of release.issues) {
      findingsCount += 1;
      const key = `${issue.type}:${issue.severity}`;
      countsByRule[key] = (countsByRule[key] ?? 0) + 1;
    }
  }
  return { findingsCount, details: { counts_by_rule: countsByRule } };
}

/**
 * Emits a single CliAnalysisCompleted event for one SCA run, carrying `details`
 * (JSON-encoded blob when findings were reported, `""` otherwise). Strictly fire-and-forget:
 * the entire body is guarded, so no telemetry failure — identity resolution
 * (`getOrCreateUserId`) or the file write — can ever propagate to the caller. This matters
 * because the analyze call site emits *after* `process.exitCode` is set, and the hook call
 * site must keep failing open; a thrown error here would otherwise turn a successful scan
 * into a failure.
 *
 * Pass `response: null` for a run that failed to execute (scanner spawn/parse error or a
 * non-zero exit that threw): the completed event is emitted with `exit_code` as supplied
 * (callers pass `null` on the throw path), `failures_count: 1`, and `details: ""`.
 *
 * `exitCode` is the CLI command's final `process.exitCode` (0/1/51 for `analyze`), not the
 * sca-scanner subprocess code; pass `null` when there is no analyze-style exit (hook) or the
 * run threw.
 */
export async function emitScaAnalysisTelemetry(
  callerCommand: ScaCallerCommand,
  auth: ResolvedAuth,
  response: AnalyzeProjectResponse | null,
  durationMs: number,
  exitCode: number | null,
): Promise<void> {
  try {
    const analysisId = randomUUID();

    if (!response) {
      await emitTelemetryEvent(
        CLI_ANALYSIS_COMPLETED,
        {
          caller_command: callerCommand,
          analyzer: 'sca-scanner-cli',
          analysis_id: analysisId,
          findings_count: 0,
          exit_code: exitCode,
          errors_count: 0,
          failures_count: 1,
          scan_duration_ms: durationMs,
          details: '',
        } satisfies AnalysisCompletedPayload,
        { auth },
      );
      return;
    }

    const { findingsCount, details } = summarizeScaFindings(response);

    await emitTelemetryEvent(
      CLI_ANALYSIS_COMPLETED,
      {
        caller_command: callerCommand,
        analyzer: 'sca-scanner-cli',
        analysis_id: analysisId,
        findings_count: findingsCount,
        exit_code: exitCode,
        errors_count: response.errors.length,
        failures_count: 0,
        scan_duration_ms: durationMs,
        details: findingsCount > 0 ? JSON.stringify(details) : '',
      } satisfies AnalysisCompletedPayload,
      { auth },
    );
  } catch {
    // Telemetry is strictly fire-and-forget; never surface to the command handler.
  }
}

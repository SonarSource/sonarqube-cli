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

// Telemetry constants for the sonar-secrets analyzer's CliAnalysisCompleted event.
// Each analyzer owns the shape of its own `details` blob
// ({ counts_by_rule, files_with_findings_count, source }).
// Bare `sonar analyze` uses caller_command `analyze` (same as SQAA); the dedicated
// `analyze secrets` subcommand uses `analyze secrets`.

import { randomUUID } from 'node:crypto';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import {
  type CommandInvocationContext,
  TelemetryFact,
} from '@/core/commands/invocation-context.ts';
import type { SpawnResult } from '@/core/process/process.ts';
import {
  buildStatsFromTelemetry,
  dedupeAgainstSeen,
  upsertRuleMessages,
} from '@/core/stats/facts.ts';

import { type AnalysisCompletedPayload, CLI_ANALYSIS_COMPLETED } from './analysis-completed.ts';
import {
  EXIT_CODE_SECRETS_FOUND,
  parseSecretsJson,
  type SecretsJsonIssue,
  type SecretsJsonOutput,
} from './secrets.ts';

/**
 * The `caller_command` value recorded on every sonar-secrets analysis event, one per
 * call site. `agentPromptSubmit` is shared by the Claude and Codex prompt-submit hooks
 * (they are distinguished by `caller_agent`, not `caller_command`).
 */
export const SECRETS_CALLER_COMMANDS = {
  analyze: 'analyze',
  analyzeSecrets: 'analyze secrets',
  analyzeDependencyRisks: 'analyze dependency-risks',
  gitPreCommit: 'git-pre-commit',
  gitPrePush: 'git-pre-push',
  agentPromptSubmit: 'agent-prompt-submit',
  cursorPromptSubmit: 'cursor-prompt-submit',
  claudePreToolUse: 'claude-pre-tool-use',
  copilotPreToolUse: 'copilot-pre-tool-use',
  antigravityPreToolUse: 'antigravity-pre-tool-use',
  cursorPreFileRead: 'cursor-pre-file-read',
  cursorPreToolUse: 'cursor-pre-tool-use',
} as const;

/** Union of the valid sonar-secrets `caller_command` values. */
export type SecretsCallerCommand =
  (typeof SECRETS_CALLER_COMMANDS)[keyof typeof SECRETS_CALLER_COMMANDS];

/**
 * Builds one CliAnalysisCompleted fact for a sonar-secrets run (`details` is a
 * JSON blob when findings were reported, `""` otherwise).
 *
 * Pass `result: null` for a run that failed to execute (spawn error or timeout):
 * `exit_code: null` and `failures_count: 1` so failed-to-run scans are still counted.
 */
function buildSecretsAnalysisTelemetryFact(
  callerCommand: SecretsCallerCommand,
  result: { exitCode: number | null; stdout: string } | null,
  durationMs: number,
  auth: ResolvedAuth,
): {
  parsed: SecretsJsonOutput;
  fact: TelemetryFact<AnalysisCompletedPayload>;
} {
  const parsed = result ? parseSecretsJson(result.stdout) : { issues: [] };

  const { issues, errors } = parsed;
  const exitCode = result?.exitCode ?? null;
  // Per-invocation failure flag (0/1): 1 when the scan did not produce a valid result — it
  // failed to run (null exit code) or exited with a non-clean, non-findings code.
  const failuresCount = exitCode === 0 || exitCode === EXIT_CODE_SECRETS_FOUND ? 0 : 1;
  const analysisId = randomUUID();

  let details = '';
  if (issues.length > 0) {
    const countsByRule: Record<string, number> = {};
    const filesWithFindings = new Set<string>();
    for (const issue of issues) {
      countsByRule[issue.ruleKey] = (countsByRule[issue.ruleKey] ?? 0) + 1;
      if (issue.file) filesWithFindings.add(issue.file);
    }
    const source: 'files' | 'stdin' = filesWithFindings.size > 0 ? 'files' : 'stdin';
    details = JSON.stringify({
      counts_by_rule: countsByRule,
      files_with_findings_count: filesWithFindings.size,
      source,
    });
  }

  return {
    parsed,
    fact: new TelemetryFact(
      CLI_ANALYSIS_COMPLETED,
      {
        caller_command: callerCommand,
        analyzer: 'sonar-secrets',
        analysis_id: analysisId,
        findings_count: issues.length,
        exit_code: exitCode,
        errors_count: errors?.length ?? 0,
        failures_count: failuresCount,
        scan_duration_ms: durationMs,
        details,
      } satisfies AnalysisCompletedPayload,
      { auth },
    ),
  };
}

const SECRETS_STATS_SCOPE = 'sonar-secrets';

export function buildSecretsFingerprint(
  ruleKey: string,
  file: string | undefined,
  startLine: number | undefined,
  startColumn: number | undefined,
): string {
  return `${ruleKey}|${file ?? ''}|${startLine ?? ''}|${startColumn ?? ''}`;
}

// rule_descriptions is a lookup, so upsert runs for every issue, not just newly-deduped ones.
// `source` disambiguates issues with no `file`, so different --input scans don't collide.
export function summarizeNewSecretsFindings(
  issues: readonly SecretsJsonIssue[],
  source?: string,
): {
  findingsCount: number;
  ruleCounts?: Record<string, number>;
} {
  if (issues.length === 0) {
    return { findingsCount: 0 };
  }

  const ruleMessages: Record<string, string> = {};
  for (const issue of issues) {
    ruleMessages[issue.ruleKey] = issue.description;
  }
  upsertRuleMessages(ruleMessages);

  const fingerprints = issues.map((issue) =>
    buildSecretsFingerprint(
      issue.ruleKey,
      issue.file ?? source,
      issue.location?.startLine,
      issue.location?.startColumn,
    ),
  );
  const newFingerprints = dedupeAgainstSeen(SECRETS_STATS_SCOPE, fingerprints);

  const ruleCounts: Record<string, number> = {};
  const countedFingerprints = new Set<string>();
  issues.forEach((issue, index) => {
    const fingerprint = fingerprints[index];
    if (!newFingerprints.has(fingerprint) || countedFingerprints.has(fingerprint)) return;
    countedFingerprints.add(fingerprint);
    ruleCounts[issue.ruleKey] = (ruleCounts[issue.ruleKey] ?? 0) + 1;
  });

  return {
    findingsCount: newFingerprints.size,
    ruleCounts: newFingerprints.size > 0 ? ruleCounts : undefined,
  };
}

/**
 * Runs one sonar-secrets spawn and records CliAnalysisCompleted for either outcome:
 *  - the process ran (any exit code) → telemetry via {@link buildSecretsAnalysisTelemetryFact};
 *  - the process failed to run (spawn error or timeout, i.e. the promise rejected) →
 *    a failures_count:1 event with exit_code null, then the error is re-thrown.
 *
 * Telemetry is always deferred via {@link CommandInvocationContext.recordTelemetry} for
 * `postAction` commit. `SonarCommand.runCommand` catches handler throws, so Commander
 * still runs `postAction` and the buffer is drained. Re-throwing preserves each
 * caller's fail-open / fail-closed handling; recording happens first so failed
 * runs are still counted.
 */
export async function scanAndEmitSecrets(
  callerCommand: SecretsCallerCommand,
  auth: ResolvedAuth,
  run: () => Promise<SpawnResult>,
  ctx: CommandInvocationContext,
  source?: string,
): Promise<{ result: SpawnResult; parsed: SecretsJsonOutput }> {
  const start = performance.now();
  try {
    const result = await run();
    const { parsed, fact } = buildSecretsAnalysisTelemetryFact(
      callerCommand,
      result,
      Math.round(performance.now() - start),
      auth,
    );
    ctx.recordTelemetry(fact);
    ctx.recordStats(() =>
      buildStatsFromTelemetry(fact, summarizeNewSecretsFindings(parsed.issues, source)),
    );
    return { result, parsed };
  } catch (err) {
    const { fact } = buildSecretsAnalysisTelemetryFact(
      callerCommand,
      null,
      Math.round(performance.now() - start),
      auth,
    );
    ctx.recordTelemetry(fact);
    ctx.recordStats(() => buildStatsFromTelemetry(fact, { findingsCount: 0 }));
    throw err;
  }
}

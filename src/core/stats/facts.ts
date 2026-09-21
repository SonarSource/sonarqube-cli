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

import {
  type CommandInvocationContext,
  StatsFact,
  type TelemetryFact,
} from '@/core/commands/invocation-context.ts';
import { detectCallerAgent } from '@/core/host/environment/agent-detector.ts';

import type { StatsAnalyzer, StatsTrigger } from './store.ts';
import { recordStatsEvent } from './store.ts';

export { dedupeAgainstSeen, upsertRuleMessages } from './store.ts';

/**
 * Base envelope every analyzer's `CliAnalysisCompleted` telemetry fact already carries.
 * `AnalysisCompletedPayload` (src/commands/analyze/analysis-completed.ts) satisfies this
 * structurally — not imported, since src/core never imports from src/commands elsewhere
 * in this codebase.
 */
export interface AnalysisFactEnvelope {
  caller_command: string;
  analyzer: StatsAnalyzer;
  exit_code: number | null;
  scan_duration_ms: number;
}

/** The only bits a stats event needs beyond the shared telemetry envelope. */
export interface AnalyzerStatsDetails {
  findingsCount: number;
  ruleCounts?: Record<string, number>;
}

/** Buffered `StatsFact` payload shape; exported so tests can build one without going
 *  through {@link recordAnalyzerStats}'s telemetry-fact parameter. */
export interface AnalyzerStatsFactPayload {
  envelope: AnalysisFactEnvelope;
  details: AnalyzerStatsDetails;
}

// Caller-command -> run-trigger classification. Deliberately not imported from
// SECRETS_CALLER_COMMANDS / SQAA_*_CALLER_COMMAND / SCA_CALLER_COMMANDS (all under
// src/commands/analyze/): src/core never imports from src/commands elsewhere in this
// codebase. Keep this list in sync by hand with those constants.
const MANUAL_CALLER_COMMANDS: ReadonlySet<string> = new Set([
  'analyze',
  'analyze secrets',
  'analyze dependency-risks',
  'analyze agentic',
  'verify',
]);

function resolveTrigger(callerCommand: string): StatsTrigger {
  return MANUAL_CALLER_COMMANDS.has(callerCommand) ? 'manual' : 'hooks';
}

// Deliberately not gated on telemetry consent — CLI-1114 will add a dedicated stats
// on/off flag around this call; do not reintroduce `isTelemetryEnabled(state)` here.
export function commitStatsFacts(facts: readonly StatsFact[]): void {
  for (const fact of facts) {
    const { envelope, details } = fact.payload as AnalyzerStatsFactPayload;
    recordStatsEvent(
      {
        callerCommand: envelope.caller_command,
        exitCode: envelope.exit_code,
        callerAgent: detectCallerAgent() ?? 'unidentified',
        runTrigger: resolveTrigger(envelope.caller_command),
        durationMs: envelope.scan_duration_ms,
      },
      {
        eventClass: 'analyzer',
        analyzer: envelope.analyzer,
        findingsCount: details.findingsCount,
        ruleCounts: details.ruleCounts,
      },
    );
  }
}

/**
 * Records a stats event from an analyzer's own `CliAnalysisCompleted` telemetry fact —
 * `caller_command`/`analyzer`/`exit_code`/`scan_duration_ms` are read straight off it, so
 * callers never rebuild that envelope by hand. `details` carries only what stats needs on
 * top of telemetry: the deduped/allowlisted finding counts, computed by each analyzer's
 * own dedup callback (secrets fingerprints against the ledger; SQAA/SCA pass raw counts,
 * no dedup this iteration — see the CLI-1112 ADR).
 */
export function recordAnalyzerStats(
  ctx: CommandInvocationContext,
  fact: TelemetryFact<AnalysisFactEnvelope>,
  details: AnalyzerStatsDetails,
): void {
  ctx.recordStats(new StatsFact<AnalyzerStatsFactPayload>({ envelope: fact.payload, details }));
}

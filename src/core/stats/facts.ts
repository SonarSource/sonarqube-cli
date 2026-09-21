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

import { StatsFact, type TelemetryFact } from '@/core/commands/invocation-context.ts';
import { detectCallerAgent } from '@/core/host/environment/agent-detector.ts';

import type { StatsAnalyzer, StatsTrigger } from './store.ts';
import { recordStatsEvent } from './store.ts';

export { dedupeAgainstSeen, upsertRuleMessages } from './store.ts';

/** Envelope every analyzer's `CliAnalysisCompleted` fact carries; satisfied structurally
 *  by `AnalysisCompletedPayload`, not imported (src/core can't import src/commands). */
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

/** Builds a stats fact from an analyzer's own telemetry fact — the envelope is read off it,
 *  so callers only ever supply `details` (their deduped/allowlisted finding counts). Callers
 *  buffer the result themselves via {@link CommandInvocationContext.recordStats}, alongside
 *  {@link CommandInvocationContext.recordTelemetry} for the telemetry fact it was built from. */
export function buildStatsFromTelemetry(
  fact: TelemetryFact<AnalysisFactEnvelope>,
  details: AnalyzerStatsDetails,
): StatsFact<AnalyzerStatsFactPayload> {
  return new StatsFact<AnalyzerStatsFactPayload>({ envelope: fact.payload, details });
}

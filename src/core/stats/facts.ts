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

import { type CommandInvocationContext, StatsFact } from '@/core/commands/invocation-context.ts';
import { detectCallerAgent } from '@/core/host/environment/agent-detector.ts';

import type { StatsAnalyzer, StatsTrigger } from './store.ts';
import { recordStatsEvent } from './store.ts';

export { dedupeAgainstSeen, upsertRuleMessages } from './store.ts';

export interface AnalyzerStatsFactPayload {
  analyzer: StatsAnalyzer;
  callerCommand: string;
  exitCode: number | null;
  durationMs?: number | null;
  findingsCount: number;
  ruleCounts?: Record<string, number>;
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
    const payload = fact.payload as AnalyzerStatsFactPayload;
    recordStatsEvent(
      {
        callerCommand: payload.callerCommand,
        exitCode: payload.exitCode,
        callerAgent: detectCallerAgent() ?? 'unidentified',
        runTrigger: resolveTrigger(payload.callerCommand),
        durationMs: payload.durationMs,
      },
      {
        eventClass: 'analyzer',
        analyzer: payload.analyzer,
        findingsCount: payload.findingsCount,
        ruleCounts: payload.ruleCounts,
      },
    );
  }
}

export function recordAnalyzerStats(
  ctx: CommandInvocationContext,
  payload: AnalyzerStatsFactPayload,
): void {
  ctx.recordStats(new StatsFact<AnalyzerStatsFactPayload>(payload));
}

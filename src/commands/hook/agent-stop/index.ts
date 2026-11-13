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

import { SQAA_AGENT_STOP_CALLER_COMMAND } from '@/commands/analyze/sqaa-analysis-telemetry.ts';
import { fingerprintGitChangeSet } from '@/commands/analyze/sqaa-fingerprint.ts';
import { buildSqaaRunReport, runSqaaAnalysis } from '@/commands/analyze/sqaa-run.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import logger from '@/core/observability/logger.ts';
import {
  acquireAnalysisLock,
  finishAnalysis,
  resetAnalysisCounterIfIdle,
} from '@/core/vortex/deep-analysis/state.ts';

import { formatSqaaJsonReportForHook } from '../format-sqaa-hook-context.ts';
import type { HookCommandResult } from '../hook-command-result.ts';
import { readStdinJson } from '../stdin.ts';
import { claudeAdapter } from './agent-adapters/claude-adapter.ts';
import type { StopAgent, StopAgentAdapter, StopInput, StopOutput } from './types.ts';

const ANALYSIS_LIMIT = 3;
const ADAPTERS: Record<StopAgent, StopAgentAdapter> = { claude: claudeAdapter };

export async function agentStop(
  ctx: CommandInvocationContext,
  agent: string,
): Promise<HookCommandResult> {
  let sessionId: string | undefined;
  try {
    if (!Object.hasOwn(ADAPTERS, agent)) return { agentSessionId: null };
    const adapter = ADAPTERS[agent as StopAgent];
    const input = adapter.parse(await readStdinJson<unknown>());
    sessionId = input.sessionId;
    const output = await resolveStopAnalysis(ctx, agent, input);
    if (output) process.stdout.write(JSON.stringify(adapter.emit(output)) + '\n');
  } catch (error) {
    logger.debug('Stop analysis skipped', error);
    if (sessionId) {
      resetAnalysisCounterIfIdle({ agent, session_id: sessionId });
    }
  }
  return { agentSessionId: sessionId ?? null };
}

/** Return feedback only after analysis and its state changes have succeeded. */
async function resolveStopAnalysis(
  ctx: CommandInvocationContext,
  agent: string,
  input: StopInput,
): Promise<StopOutput | null> {
  const session = { agent, session_id: input.sessionId };
  const connection = await ctx.resolveConnection();
  if (!connection) {
    logger.debug('Vortex stop analysis skipped: no connection');
    resetAnalysisCounterIfIdle(session);
    return null;
  }
  const fingerprint = await fingerprintGitChangeSet(input.cwd);
  const acquired = acquireAnalysisLock({ ...session, fingerprint, analysisLimit: ANALYSIS_LIMIT });
  if (!acquired) {
    logger.debug('Vortex stop analysis skipped: fingerprint lock was not acquired');
    resetAnalysisCounterIfIdle(session);
    return null;
  }
  let shouldContinue: boolean | null = null;
  try {
    const run = await runSqaaAnalysis(
      { cwd: input.cwd, forcedDepth: 'DEEP', format: 'json' },
      connection,
      {
        console: ctx.console,
        format: 'json',
        requireProject: false,
        silentSkip: true,
        noteFocusedProject: false,
        onExecutionError: 'record-and-skip',
        telemetryCtx: ctx,
        telemetryCallerCommand: SQAA_AGENT_STOP_CALLER_COMMAND,
        telemetryProcessExitCode: 0,
      },
    );
    if (
      !run ||
      run.prepared.files.displayPaths.length === 0 ||
      run.tally.globalError ||
      run.tally.totalFailures > 0 ||
      run.tally.totalErrors > 0
    ) {
      logger.debug(
        'Vortex stop analysis skipped: no complete analysis result',
        {
          files: run?.prepared.files.displayPaths.length,
          failures: run?.tally.totalFailures,
          errors: run?.tally.totalErrors,
        },
        run?.tally.globalError,
      );
      return null;
    }
    // Another agent or the user edited files during analysis, so these results are outdated.
    if ((await fingerprintGitChangeSet(input.cwd)) !== fingerprint) {
      logger.debug('Vortex stop analysis discarded because the Git change set changed');
      return null;
    }
    const feedback =
      run.tally.totalIssues > 0
        ? formatSqaaJsonReportForHook(buildSqaaRunReport(run.prepared, run.tally))
        : null;
    shouldContinue = Boolean(feedback) && acquired.analysisCount < ANALYSIS_LIMIT;
    if (!feedback) {
      logger.debug('Vortex stop analysis completed without feedback');
      return null;
    }
    const message = shouldContinue
      ? 'Vortex analysis found the following issues. Fix them:'
      : `Vortex analysis reached its limit of ${ANALYSIS_LIMIT} attempts. These issues remain:`;
    return { findings: `${message}\n\n${feedback}`, shouldContinue };
  } finally {
    // Expired ownership rejects late results before continuation can reach the agent.
    if (shouldContinue === null) finishAnalysis(acquired.lock, 'failed');
    else finishAnalysis(acquired.lock, shouldContinue ? 'continue' : 'stop');
  }
}

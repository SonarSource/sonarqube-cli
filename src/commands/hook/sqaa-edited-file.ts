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

import { existsSync } from 'node:fs';

import {
  SQAA_HOOK_TELEMETRY_EXIT_CODE,
  type SqaaTelemetryCallerCommand,
} from '@/commands/analyze/sqaa-analysis-telemetry.ts';
import { runSqaaAnalysis } from '@/commands/analyze/sqaa-run.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import logger from '@/core/observability/logger.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { SqaaForbiddenError } from '@/core/server/errors.ts';

import { formatSqaaIssuesForHook } from './format-sqaa-hook-context.ts';

type EditedFileResult =
  { kind: 'context'; context: string } | { kind: 'forbidden'; connection: SonarConnection };

export async function analyzeEditedSqaaFile(
  filePath: string,
  ctx: CommandInvocationContext,
  callerCommand: SqaaTelemetryCallerCommand,
): Promise<EditedFileResult | null> {
  if (!existsSync(filePath)) return null;
  const connection = await ctx.resolveConnection();
  if (!connection) return null;
  const run = await runSqaaAnalysis({ editedFile: filePath, forcedDepth: 'STANDARD' }, connection, {
    requireProject: false,
    silentSkip: true,
    noteFocusedProject: false,
    onExecutionError: 'record-and-skip',
    telemetryCtx: ctx,
    telemetryCallerCommand: callerCommand,
    telemetryProcessExitCode: SQAA_HOOK_TELEMETRY_EXIT_CODE,
    console: ctx.console,
    format: 'json',
  });
  if (!run) return null;
  const { tally } = run;
  if (tally.globalError instanceof SqaaForbiddenError) return { kind: 'forbidden', connection };
  const result = tally.allResults[0];
  if ('failure' in result) {
    logger.debug(`PostToolUse SQAA analysis failed: ${result.failure.message}`);
    return null;
  }
  try {
    return {
      kind: 'context',
      context: formatSqaaIssuesForHook(result.issues, result.errors, result.filePath),
    };
  } catch (err) {
    logger.debug(`PostToolUse SQAA hook output failed: ${(err as Error).message}`);
    return null;
  }
}

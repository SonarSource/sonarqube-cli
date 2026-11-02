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

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import type {
  CommandAuthenticatedInvocationContext,
  CommandInvocationContext,
} from '@/core/commands/invocation-context.ts';
import { resolveFormatOption } from '@/core/commands/params.ts';
import type { SonarConnection } from '@/core/server/connection.ts';

import { prepareSqaaRun } from './sqaa-context.ts';
import { applyExitCode, type SqaaJsonReport } from './sqaa-display.ts';
import { buildSqaaRunReport, executeSqaaRun, presentSqaaRun } from './sqaa-run.ts';
import type { AnalyzeSqaaOptions, AnalyzeSqaaRunOptions } from './sqaa-types.ts';
import { VALID_FORMATS } from './sqaa-types.ts';

export {
  type AnalyzeSqaaOptions,
  type AnalyzeSqaaRunOptions,
  type OutputFormat,
  VALID_FORMATS,
} from './sqaa-types.ts';

export async function analyzeSqaa(
  options: AnalyzeSqaaOptions,
  ctx: CommandAuthenticatedInvocationContext,
  runOptions: AnalyzeSqaaRunOptions = {},
): Promise<void> {
  const format = resolveFormatOption(options.format, VALID_FORMATS, 'text');
  if (options.staged && options.base !== undefined) {
    throw new InvalidOptionError('--staged and --base cannot be used together');
  }
  const telemetryCtx = runOptions.telemetryCtx ?? ctx;
  const { console } = telemetryCtx;
  const prepared = await prepareSqaaRun({ ...options, format }, ctx.connection, console, {
    ...runOptions,
    requireProject: runOptions.requireProject ?? true,
  });
  if (!prepared) return;
  if (prepared.files.displayPaths.length === 0) {
    console.text(
      prepared.ignored.length === 0
        ? 'Vortex analysis: no files in the change set to analyze.'
        : 'Vortex analysis: no files to analyze. All change set files were excluded (binary, oversized, or outside the repository or project).',
    );
    return;
  }
  const execution = { ...runOptions, format, telemetryCtx, console };
  const { tally } = await executeSqaaRun(prepared, execution);
  applyExitCode(tally.totalIssues, tally.totalFailures, tally.globalError !== undefined);
  await presentSqaaRun(prepared, tally, execution);
}

export async function buildSqaaJsonReport(
  options: AnalyzeSqaaOptions,
  connection: SonarConnection,
  runOptions: AnalyzeSqaaRunOptions & { telemetryCtx: CommandInvocationContext },
): Promise<SqaaJsonReport | null> {
  const { console } = runOptions.telemetryCtx;
  const prepared = await prepareSqaaRun(options, connection, console, {
    requireProject: false,
    silentSkip: runOptions.silentSkip,
  });
  if (!prepared) return null;
  const { tally } = await executeSqaaRun(prepared, { ...runOptions, console, format: 'json' });
  return buildSqaaRunReport(prepared, tally);
}

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
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveFormatOption } from '@/core/commands/params.ts';

import { prepareSqaaRun } from './sqaa-context.ts';
import {
  runSqaaAnalysis,
  runSqaaAnalysisOnExplicitFiles,
  runSqaaAnalysisOnFiles,
} from './sqaa-run.ts';
import type { AnalyzeSqaaOptions, AnalyzeSqaaRunOptions } from './sqaa-types.ts';
import { VALID_FORMATS } from './sqaa-types.ts';

export { buildSqaaJsonReport } from './sqaa-json-report.ts';
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
  const execution = {
    format,
    telemetryCallerCommand: runOptions.telemetryCallerCommand,
    telemetryCtx,
    console,
  };
  if (prepared.mode === 'single-file') await runSqaaAnalysis(prepared, execution);
  else if (prepared.mode === 'multi-file')
    await runSqaaAnalysisOnExplicitFiles(prepared, execution);
  else await runSqaaAnalysisOnFiles(prepared, execution);
}

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

import { createFindingsApi } from '../../_common/architecture-api.ts';
import type { CurrentReadOptions } from '../../_common/dependency-query.ts';
import { toArchitectureError } from '../../_common/errors.ts';
import { resolveProject } from '../../_common/project.ts';
import { defaultTextFormat, printPayload, TEXT_FORMATS } from '../../_common/read-options.ts';
import { SUMMARY_CATEGORIES } from '../../_common/summary.ts';

export async function getSummary(
  options: CurrentReadOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  if (
    options.component !== undefined ||
    options.depth !== undefined ||
    options.from !== undefined ||
    options.to !== undefined ||
    options.page !== undefined ||
    options.pageSize !== undefined
  ) {
    throw new InvalidOptionError('--summary cannot be combined with graph or dependency filters.');
  }
  const project = await resolveProject(options, ctx);
  const format = resolveFormatOption(options.format, TEXT_FORMATS, defaultTextFormat());
  const api = createFindingsApi(ctx.connection, project);
  const result = await api.getSummaryCounts(options.language).catch((error: unknown) => {
    throw toArchitectureError(error, project, ctx.connection.httpClient.isCloud);
  });
  const { summaries, skippedSummaries } = result;
  if (format !== 'text') {
    printPayload(ctx, format, {
      project,
      summaries,
      ...(skippedSummaries
        ? {
            skippedSummaries,
            message: `Skipped ${skippedSummaries} summary result(s) with unsupported languages.`,
          }
        : summaries.length
          ? {}
          : {
              message: 'No architecture summaries are visible. Check project access and analysis.',
            }),
    });
    return;
  }
  if (skippedSummaries)
    ctx.console.warn(`Skipped ${skippedSummaries} summary result(s) with unsupported languages.`);
  if (!summaries.length && !skippedSummaries)
    ctx.console.info('No architecture summaries are visible. Check project access and analysis.');
  for (const summary of summaries) {
    ctx.console.info(`${summary.language}:`);
    for (const category of ['deviations', 'flaws', 'smells'] as const) {
      const types = SUMMARY_CATEGORIES[category];
      const counts = summary[category];
      const details = types.map((type) => `${type}: ${counts[type]}`).join(', ');
      ctx.console.info(`  ${category}: ${counts.total} (${details})`);
    }
  }
}

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

import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveFormatOption } from '@/core/commands/params.ts';

import { ECOSYSTEMS } from '../../_common/architecture-api.ts';
import { incompatibleResponse, toArchitectureError } from '../../_common/errors.ts';
import { resolveProject } from '../../_common/project.ts';
import {
  type ArchitectureReadOptions,
  defaultTextFormat,
  printPayload,
  TEXT_FORMATS,
} from '../../_common/read-options.ts';
import { SonarArchitectureApi } from '../../_common/sonar-architecture-api.ts';

const categories = {
  deviations: ['structuralDeviation', 'relationshipDeviation'],
  flaws: ['tangle', 'oversizedComponent'],
  smells: ['weakTangle', 'splitResponsibility'],
} as const;

export function parseSummaries(value: unknown, language?: string): Record<string, unknown>[] {
  const invalid = () => incompatibleResponse('Invalid public architecture summary response.');
  if (
    !value ||
    typeof value !== 'object' ||
    !('projectSummaries' in value) ||
    !Array.isArray(value.projectSummaries)
  )
    throw invalid();
  const seen = new Set<string>();
  return value.projectSummaries.map((item: unknown) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !('language' in item) ||
      typeof item.language !== 'string' ||
      !ECOSYSTEMS.some((name) => name === item.language) ||
      (language && item.language !== language) ||
      seen.has(item.language)
    )
      throw invalid();
    seen.add(item.language);
    const result: Record<string, unknown> = { language: item.language };
    for (const [category, types] of Object.entries(categories)) {
      if (!(category in item)) throw invalid();
      const counts = (item as Record<string, unknown>)[category];
      if (!counts || typeof counts !== 'object') throw invalid();
      const source = counts as Record<string, unknown>;
      const keys = ['total', ...types];
      if (
        keys.some(
          (key) =>
            typeof source[key] !== 'number' ||
            !Number.isSafeInteger(source[key]) ||
            source[key] < 0,
        )
      )
        throw invalid();
      if (source.total !== types.reduce((sum, key) => sum + (source[key] as number), 0))
        throw invalid();
      result[category] = Object.fromEntries(keys.map((key) => [key, source[key]]));
    }
    return result;
  });
}

export async function getSummary(
  options: ArchitectureReadOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const project = await resolveProject(options, ctx);
  const format = resolveFormatOption(options.format, TEXT_FORMATS, defaultTextFormat());
  const api = new SonarArchitectureApi(ctx.connection, project);
  const response = await api.getSummary(options.language).catch((error: unknown) => {
    throw toArchitectureError(error, project, ctx.connection.httpClient.isCloud);
  });
  const summaries = parseSummaries(response, options.language);
  if (format !== 'text') {
    printPayload(ctx, format, {
      project,
      summaries,
      ...(summaries.length
        ? {}
        : { message: 'No architecture summaries are visible. Check project access and analysis.' }),
    });
    return;
  }
  if (!summaries.length)
    ctx.console.info('No architecture summaries are visible. Check project access and analysis.');
  for (const summary of summaries) ctx.console.info(JSON.stringify(summary));
}

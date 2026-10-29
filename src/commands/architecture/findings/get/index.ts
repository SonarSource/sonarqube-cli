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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveFormatOption } from '@/core/commands/params.ts';

import { createFindingsApi } from '../../_common/architecture-api.ts';
import { toArchitectureError } from '../../_common/errors.ts';
import {
  DEFAULT_FINDINGS_PAGE_SIZE,
  type FindingCategory,
  type ProjectFinding,
} from '../../_common/findings.ts';
import { resolveProject } from '../../_common/project.ts';
import {
  type ArchitectureReadOptions,
  defaultTextFormat,
  printPayload,
  TEXT_FORMATS,
} from '../../_common/read-options.ts';

export interface FindingsReadOptions extends ArchitectureReadOptions {
  id?: string;
  category?: FindingCategory;
  page?: number;
  pageSize?: number;
}

export async function getFindings(
  options: FindingsReadOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const projectKey = await resolveProject(options, ctx);
  const format = resolveFormatOption(options.format, TEXT_FORMATS, defaultTextFormat());
  const api = createFindingsApi(ctx.connection, projectKey);
  if (options.id !== undefined) {
    if (
      options.category !== undefined ||
      options.page !== undefined ||
      options.pageSize !== undefined
    )
      throw new CommandFailedError('Use either --id or --category and pagination options.');
    const finding = await api.getFinding(options.id).catch((error: unknown) => {
      throw toArchitectureError(error, projectKey);
    });
    if (format === 'text') {
      ctx.console.info(summary(finding));
      for (const [name, value] of Object.entries(finding))
        if (!['id', 'projectId', 'category', 'message'].includes(name))
          ctx.console.info(`  ${name}: ${JSON.stringify(value)}`);
    } else printPayload(ctx, format, { project: projectKey, finding });
    return;
  }
  const { findings, page } = await api
    .getFindingsPage(
      options.category,
      options.page ?? 1,
      options.pageSize ?? DEFAULT_FINDINGS_PAGE_SIZE,
    )
    .catch((error: unknown) => {
      throw toArchitectureError(error, projectKey);
    });
  if (format !== 'text') {
    printPayload(ctx, format, { project: projectKey, findings, page });
    return;
  }
  if (findings.length === 0 && page.total === 0)
    ctx.console.info(
      'No findings are visible. Check project access and whether the project has been analyzed.',
    );
  ctx.console.info(
    `Page ${page.pageIndex}: ${findings.length} of ${page.total} findings.${page.pageIndex * page.pageSize < page.total ? ' Use --page to continue.' : ''}`,
  );
  for (const finding of findings) ctx.console.info(summary(finding));
}

function summary(finding: ProjectFinding): string {
  return `${finding.id}: ${finding.category}${finding.message ? ` ${finding.message}` : ''}`;
}

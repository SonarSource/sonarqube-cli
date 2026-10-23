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

import { createDirectivesApi } from '../../_common/architecture-api.ts';
import { toArchitectureError } from '../../_common/errors.ts';
import { resolveProject } from '../../_common/project.ts';
import {
  type ArchitectureReadOptions,
  defaultTextFormat,
  printPayload,
  TEXT_FORMATS,
} from '../../_common/read-options.ts';

export interface DirectivesReadOptions extends ArchitectureReadOptions {
  id?: string;
  page?: number;
  pageSize?: number;
}

export async function getDirectives(
  options: DirectivesReadOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const projectKey = await resolveProject(options, ctx);
  const format = resolveFormatOption(options.format, TEXT_FORMATS, defaultTextFormat());
  if (options.id !== undefined) {
    if (options.page !== undefined || options.pageSize !== undefined)
      throw new CommandFailedError('Use either --id or pagination options.');
    const directive = await createDirectivesApi(ctx.connection, projectKey)
      .getDirective(options.id)
      .catch((error: unknown) => {
        throw toArchitectureError(error, projectKey);
      });
    if (format === 'text')
      ctx.console.info(
        `${directive.id}: ${directive.type} ${directive.fromNodeKey} -> ${directive.toNodeKey}`,
      );
    else printPayload(ctx, format, { project: projectKey, directive });
    return;
  }
  const { directives, page } = await createDirectivesApi(ctx.connection, projectKey)
    .getDirectivesPage(options.page ?? 1, options.pageSize ?? 50)
    .catch((error: unknown) => {
      throw toArchitectureError(error, projectKey);
    });
  if (format !== 'text') {
    printPayload(ctx, format, { project: projectKey, directives, page });
    return;
  }
  if (directives.length === 0 && page.total === 0)
    ctx.console.info(
      'No directives are visible. Check project access and whether any directives are defined.',
    );
  ctx.console.info(
    `Page ${page.pageIndex}: ${directives.length} of ${page.total} directives.${page.pageIndex * page.pageSize < page.total ? ' Use --page to continue.' : ''}`,
  );
  for (const directive of directives)
    ctx.console.info(
      `${directive.id}: ${directive.type} ${directive.ecosystem} ${directive.graphType}${directive.graphPerspective ? ` [${directive.graphPerspective}]` : ''} ${directive.fromNodeKey} -> ${directive.toNodeKey}`,
    );
}

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

import { createFindingsApi } from '../../_common/architecture-api.ts';
import { toArchitectureError } from '../../_common/errors.ts';
import {
  DEFAULT_FINDINGS_PAGE_SIZE,
  type FindingFilters,
  type ProjectFinding,
  validateFindingFilters,
} from '../../_common/findings.ts';
import { resolveProject } from '../../_common/project.ts';
import {
  type ArchitectureReadOptions,
  defaultTextFormat,
  printPayload,
  TEXT_FORMATS,
} from '../../_common/read-options.ts';

export interface FindingsReadOptions extends ArchitectureReadOptions, FindingFilters {
  page?: number;
  pageSize?: number;
}

export async function getFindings(
  options: FindingsReadOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  validateFindingFilters(options);
  const projectKey = await resolveProject(options, ctx);
  const format = resolveFormatOption(options.format, TEXT_FORMATS, defaultTextFormat());
  const api = createFindingsApi(ctx.connection, projectKey);
  const { findings, page, skippedFindings } = await api
    .getFindingsPage(
      { category: options.category, type: options.type, language: options.language },
      options.page ?? 1,
      options.pageSize ?? DEFAULT_FINDINGS_PAGE_SIZE,
    )
    .catch((error: unknown) => {
      throw toArchitectureError(error, projectKey, ctx.connection.httpClient.isCloud);
    });
  if (format !== 'text') {
    printPayload(ctx, format, {
      project: projectKey,
      findings,
      page,
      ...(skippedFindings ? { skippedFindings } : {}),
    });
    return;
  }
  const filters = [
    options.category && `category=${options.category}`,
    options.type && `type=${options.type}`,
    options.language && `language=${options.language}`,
  ]
    .filter(Boolean)
    .join(', ');
  if (skippedFindings)
    ctx.console.info(
      `Skipped ${skippedFindings} finding(s) with unsupported type, language or reason; backend total is unchanged.`,
    );
  if (page.total === 0)
    ctx.console.info(
      filters
        ? `No findings match ${filters}.`
        : 'No findings are visible. Check project access and whether the project has been analyzed.',
    );
  if (
    page.total > 0 &&
    page.pageSize > 0 &&
    page.pageIndex > Math.ceil(page.total / page.pageSize)
  ) {
    const last = Math.ceil(page.total / page.pageSize);
    ctx.console.info(
      `Requested page ${page.pageIndex} is past the last page (${last}). Use --page ${last}.`,
    );
  }
  let more = '';
  if (page.pageSize === 0) more = ' Use --page-size greater than 0 to read findings.';
  else if (page.pageIndex * page.pageSize < page.total) more = ' Use --page to continue.';
  ctx.console.info(`Page ${page.pageIndex}: ${findings.length} of ${page.total} findings.${more}`);
  for (const finding of findings) printFindingDetails(ctx, finding);
}

function printFindingDetails(ctx: CommandAuthenticatedInvocationContext, finding: ProjectFinding) {
  ctx.console.info(`${finding.category}: ${finding.type} (${finding.language})`);
  ctx.console.info(`  ${findingDescription(finding)}`);
  if (finding.files.length) ctx.console.info(`  files: ${finding.files.join(', ')}`);
}

function findingDescription(finding: ProjectFinding): string {
  const d = finding.details;
  switch (finding.type) {
    case 'structuralDeviation':
      return `${d.nodeKey} (${d.reason}${countText(d.misplacedComponentCount, 'component')})`;
    case 'relationshipDeviation':
      return `${d.fromNodeKey} -> ${d.toNodeKey} (${d.reason}${countText(d.dependencyCount, 'dependency', 'dependencies')})`;
    case 'tangle':
    case 'weakTangle':
      return `${d.nodeKeys?.join(', ')} (${d.nodeCount} ${d.nodeCount === 1 ? 'node' : 'nodes'})`;
    case 'oversizedComponent':
    case 'splitResponsibility': {
      const counts = [
        countText(d.leafArtifactCount, 'leaf artifact'),
        countText(d.fragmentCount, 'fragment'),
      ]
        .filter(Boolean)
        .map((text) => text.slice(2))
        .join(', ');
      return counts ? `${d.nodeKey} (${counts})` : `${d.nodeKey}`;
    }
  }
}

function countText(count: number | undefined, singular: string, plural = `${singular}s`): string {
  return count === undefined ? '' : `, ${count} ${count === 1 ? singular : plural}`;
}

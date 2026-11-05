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

import logger from '@/core/observability/logger.ts';
import type { IssuesClient } from '@/core/server/issues.ts';

import { DEFAULT_STATUSES } from '../../list/issues.ts';

const SOFTWARE_QUALITIES = ['SECURITY', 'RELIABILITY', 'MAINTAINABILITY'] as const;
const SEVERITIES = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
const SEVERITY_FACET = 'impactSeverities';

const QUALITY_LABELS: Record<SoftwareQuality, string> = {
  SECURITY: 'Security',
  RELIABILITY: 'Reliability',
  MAINTAINABILITY: 'Maintainability',
};

type SoftwareQuality = (typeof SOFTWARE_QUALITIES)[number];
type Severity = (typeof SEVERITIES)[number];

export interface QualityRow {
  quality: SoftwareQuality;
  bySeverity: Record<Severity, number>;
  total: number;
}

/**
 * Open issues counted per software quality and impact severity. An issue with impacts in several
 * qualities appears in each of those rows, so the rows can add up to more than `distinctIssues`.
 */
export interface IssueBreakdown {
  rows: QualityRow[];
  distinctIssues: number;
}

interface BreakdownQuery {
  issues: IssuesClient;
  projectKey: string;
  organization: string | undefined;
}

async function readRow(
  { issues, projectKey, organization }: BreakdownQuery,
  quality: SoftwareQuality,
): Promise<QualityRow | null> {
  return issues
    .searchIssues({
      projects: projectKey,
      organization,
      issueStatuses: DEFAULT_STATUSES.join(','),
      impactSoftwareQualities: quality,
      facets: SEVERITY_FACET,
      ps: 1,
      p: 1,
    })
    .match(
      (result) => {
        const facet = result.facets?.find((candidate) => candidate.property === SEVERITY_FACET);
        if (!facet) {
          logger.debug(`No ${SEVERITY_FACET} facet in the ${quality} issues of '${projectKey}'.`);
          return null;
        }
        const counts = new Map(facet.values.map(({ val, count }) => [val, count]));
        const bySeverity = Object.fromEntries(
          SEVERITIES.map((severity) => [severity, counts.get(severity) ?? 0]),
        ) as Record<Severity, number>;
        return { quality, bySeverity, total: result.total };
      },
      (error) => {
        logger.debug(`Could not read the ${quality} issues of '${projectKey}': ${error.message}`);
        return null;
      },
    );
}

/**
 * One request per software quality, since a facet is one-dimensional: filtering by quality and
 * faceting by severity is what pairs the two. `null` when any request fails or lacks the facet, so
 * the table is either complete or absent.
 */
export async function readIssueBreakdown(
  query: BreakdownQuery,
  distinctIssues: number,
): Promise<IssueBreakdown | null> {
  const rows = await Promise.all(SOFTWARE_QUALITIES.map((quality) => readRow(query, quality)));
  return rows.every((row) => row !== null) ? { rows, distinctIssues } : null;
}

/** The table, the note explaining overlapping rows when needed, and a closing blank line. */
export function formatIssueBreakdown({ rows, distinctIssues }: IssueBreakdown): string[] {
  const header = ['QUALITY', ...SEVERITIES, 'TOTAL'];
  const cells = rows.map(({ quality, bySeverity, total }) => [
    QUALITY_LABELS[quality],
    ...SEVERITIES.map((severity) => String(bySeverity[severity])),
    String(total),
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...cells.map((row) => row[column].length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[0]) : cell.padStart(widths[column]),
      )
      .join('  ');

  const lines = ['', `  ${line(header)}`, ...cells.map((row) => `  ${line(row)}`)];
  if (rows.reduce((sum, row) => sum + row.total, 0) > distinctIssues) {
    lines.push('', '  An issue with impacts in several qualities is counted in each of them.');
  }
  lines.push('');
  return lines;
}

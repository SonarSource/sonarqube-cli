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

// Issues command - search for SonarQube issues

import { encode as encodeToToon } from '@toon-format/toon';

import type { ResolvedAuth } from '@/core/server/auth-resolver.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import { IssuesClient } from '@/core/server/issues.ts';
import { MAX_PAGE_SIZE } from '@/core/server/projects.ts';
import type { IssuesSearchParams } from '@/core/server/types.ts';
import { print } from '@/core/ui';
import { formatCSV } from '@/core/ui/formatter/csv.ts';
import { formatTable } from '@/core/ui/formatter/table.ts';

import { InvalidOptionError } from '../_common/error.ts';

export const VALID_FORMATS = ['json', 'toon', 'table', 'csv'];
export const VALID_STANDARD_SEVERITIES = ['INFO', 'MINOR', 'MAJOR', 'CRITICAL', 'BLOCKER'];
export const VALID_MQR_SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'BLOCKER'];
export const VALID_STATUSES = ['OPEN', 'CONFIRMED', 'FALSE_POSITIVE', 'ACCEPTED', 'FIXED'];

export interface ListIssuesOptions {
  project?: string;
  severities?: string;
  type?: string;
  statuses?: string;
  rule?: string;
  tag?: string;
  branch?: string;
  pullRequest?: string;
  resolved?: boolean;
  format?: string;
  pageSize: number;
  page: number;
}

function normalizeSeverityValues(raw: string): string[] {
  return raw.split(',').map((s) => s.trim().toUpperCase());
}

function parseSeverities(
  raw: string,
  mode: 'mqr' | 'standard',
): { severities?: string; impactSeverities?: string } {
  const values = normalizeSeverityValues(raw);
  const validSet = mode === 'mqr' ? VALID_MQR_SEVERITIES : VALID_STANDARD_SEVERITIES;
  if (values.some((s) => !validSet.includes(s))) {
    throw new InvalidOptionError(
      `Invalid severity(es): '${raw}'. Valid values for ${mode === 'mqr' ? 'Multi-Quality Rule (MQR)' : 'Standard Experience'} mode: ${validSet.join(', ')}.`,
    );
  }
  return mode === 'mqr' ? { impactSeverities: values.join(',') } : { severities: values.join(',') };
}

/**
 * Issues search command handler
 */
export async function listIssues(options: ListIssuesOptions, auth: ResolvedAuth): Promise<void> {
  if (!options.project) {
    throw new InvalidOptionError('--project is required.', 'Add --project <key>.');
  }

  const format = options.format ?? 'json';
  if (!VALID_FORMATS.includes(format.toLowerCase())) {
    throw new InvalidOptionError(
      `Invalid format: '${format}'. Must be one of: ${VALID_FORMATS.join(', ')}`,
    );
  }

  const ps = options.pageSize;
  if (ps < 1 || ps > MAX_PAGE_SIZE) {
    throw new InvalidOptionError(
      `Invalid --page-size option: '${ps}'. Must be an integer between 1 and 500`,
    );
  }

  const page = options.page;
  if (page < 1) {
    throw new InvalidOptionError(`Invalid --page option: '${page}'. Must be an integer >= 1`);
  }

  let normalizedStatuses = options.statuses;
  if (normalizedStatuses) {
    const statuses = normalizedStatuses.split(',').map((s) => s.toUpperCase());
    if (!statuses.every((s) => VALID_STATUSES.includes(s))) {
      throw new InvalidOptionError(
        `Invalid status(es): '${options.statuses}'. Valid statuses are: ${VALID_STATUSES.join(', ')}`,
      );
    }
    normalizedStatuses = statuses.join(',');
  }

  if (options.severities) {
    const preflightValues = normalizeSeverityValues(options.severities);
    if (
      preflightValues.some(
        (s) => !VALID_STANDARD_SEVERITIES.includes(s) && !VALID_MQR_SEVERITIES.includes(s),
      )
    ) {
      throw new InvalidOptionError(
        `Invalid severity(es): '${options.severities}'. ` +
          `Multi-Quality Rule (MQR) mode values: ${VALID_MQR_SEVERITIES.join(', ')}. ` +
          `Standard Experience mode values: ${VALID_STANDARD_SEVERITIES.join(', ')}.`,
      );
    }
  }

  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  const issuesClient = new IssuesClient(client);

  const { severities: normalizedSeverities, impactSeverities: normalizedImpactSeverities } =
    options.severities ? parseSeverities(options.severities, await client.getServerMode()) : {};

  const params: IssuesSearchParams = {
    projects: options.project,
    organization: auth.orgKey,
    severities: normalizedSeverities,
    impactSeverities: normalizedImpactSeverities,
    types: options.type,
    issueStatuses: normalizedStatuses,
    rules: options.rule,
    tags: options.tag,
    branch: options.branch,
    pullRequest: options.pullRequest,
    resolved: options.resolved,
    ps: options.pageSize,
    p: page,
  };

  const result = await issuesClient.searchIssues(params);

  let output: string;

  switch (format.toLowerCase()) {
    case 'toon':
      output = encodeToToon(result);
      break;
    case 'json':
      output = JSON.stringify(result, null, 2);
      break;
    case 'table':
      output = formatTable(result.issues);
      break;
    case 'csv':
      output = formatCSV(result.issues);
      break;
    default:
      output = JSON.stringify(result, null, 2);
  }

  print(output);
}

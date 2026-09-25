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

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveFormatOption } from '@/core/commands/parsing.ts';
import { resolveFileComponentKey } from '@/core/file-component.ts';
import { resolveProjectKey } from '@/core/project-info.ts';
import { autoResolvePullRequest } from '@/core/pull-request-auto-resolve.ts';
import { IssuesClient } from '@/core/server/issues.ts';
import { MAX_PAGE_SIZE } from '@/core/server/projects.ts';
import { SystemClient } from '@/core/server/system.ts';
import type { IssuesSearchParams, SonarQubeIssue } from '@/core/server/types.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { columnFormatting } from '@/core/ui/formatter/column-formatting.ts';
import { formatCSV } from '@/core/ui/formatter/csv.ts';

const MIN_SEVERITY_WIDTH = 8;
const MIN_RULE_WIDTH = 15;
const MIN_MESSAGE_WIDTH = 50;

function formatTable(issues: SonarQubeIssue[]): string {
  if (issues.length === 0) {
    return 'No issues found';
  }

  const [severityWidth, ruleWidth, messageWidth] = columnFormatting(
    [issues.map((i) => i.severity), issues.map((i) => i.rule), issues.map((i) => i.message)],
    [MIN_SEVERITY_WIDTH, MIN_RULE_WIDTH, MIN_MESSAGE_WIDTH],
  );

  const header = [
    'SEVERITY'.padEnd(severityWidth),
    'RULE'.padEnd(ruleWidth),
    'MESSAGE'.padEnd(messageWidth),
    'FILE',
  ].join(' | ');

  const separator = '-'.repeat(header.length);

  const lines = [header, separator];

  for (const issue of issues) {
    const file = issue.component.split(':').pop() || issue.component;
    const line = [
      issue.severity.padEnd(severityWidth),
      issue.rule.padEnd(ruleWidth),
      issue.message.substring(0, messageWidth).padEnd(messageWidth),
      `${file}:${issue.line || '?'}`,
    ].join(' | ');
    lines.push(line);
  }

  return lines.join('\n');
}

export const VALID_FORMATS = ['json', 'toon', 'table', 'csv'] as const;
export const VALID_STANDARD_SEVERITIES = ['INFO', 'MINOR', 'MAJOR', 'CRITICAL', 'BLOCKER'];
export const VALID_MQR_SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'BLOCKER'];
export const VALID_STATUSES = ['OPEN', 'CONFIRMED', 'FALSE_POSITIVE', 'ACCEPTED', 'FIXED'];
export const DEFAULT_STATUSES = ['OPEN', 'CONFIRMED'];

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
  file?: string;
  newCode?: boolean;
  format?: string;
  pageSize: number;
  page: number;
}

function normalizeSeverityValues(raw: string): string[] {
  return raw.split(',').map((s) => s.trim().toUpperCase());
}

function resolveStatuses(statuses: string | undefined): string {
  if (!statuses) {
    return DEFAULT_STATUSES.join(',');
  }
  const normalized = statuses.split(',').map((s) => s.toUpperCase());
  if (!normalized.every((s) => VALID_STATUSES.includes(s))) {
    throw new InvalidOptionError(
      `Invalid status(es): '${statuses}'. Valid statuses are: ${VALID_STATUSES.join(', ')}`,
    );
  }
  return normalized.join(',');
}

function validateSeveritiesOption(severities: string | undefined): void {
  if (!severities) return;
  const preflightValues = normalizeSeverityValues(severities);
  if (
    preflightValues.some(
      (s) => !VALID_STANDARD_SEVERITIES.includes(s) && !VALID_MQR_SEVERITIES.includes(s),
    )
  ) {
    throw new InvalidOptionError(
      `Invalid severity(es): '${severities}'. ` +
        `Multi-Quality Rule (MQR) mode values: ${VALID_MQR_SEVERITIES.join(', ')}. ` +
        `Standard Experience mode values: ${VALID_STANDARD_SEVERITIES.join(', ')}.`,
    );
  }
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
export async function listIssues(
  options: ListIssuesOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth, console } = ctx;

  const format = resolveFormatOption(options.format, VALID_FORMATS, 'json');

  if (options.branch && options.pullRequest) {
    throw new InvalidOptionError('--branch and --pull-request cannot be used together.');
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

  const normalizedStatuses = resolveStatuses(options.statuses);
  validateSeveritiesOption(options.severities);

  const projectKey = await resolveProjectKey(options.project, auth, console);
  noteProject(auth, projectKey);

  const client = ctx.connection.httpClient;
  const issuesClient = new IssuesClient(client);

  const { branch } = options;
  let { pullRequest } = options;
  if (!branch && !pullRequest) {
    const autoDetected = await autoResolvePullRequest(client, projectKey);
    if (autoDetected) {
      pullRequest = autoDetected.pullRequest;
      console.print(
        `     Using pull request ${pullRequest} (auto-detected from branch ${autoDetected.branch})`,
        'stderr',
      );
    }
  }

  let componentKeys: string | undefined;
  if (options.file) {
    ({ componentKey: componentKeys } = await resolveFileComponentKey(
      client,
      projectKey,
      options.file,
      {
        branch,
        pullRequest,
      },
    ));
  }

  const { severities: normalizedSeverities, impactSeverities: normalizedImpactSeverities } =
    options.severities
      ? parseSeverities(
          options.severities,
          await new SystemClient(client).getServerMode().orThrow(),
        )
      : {};

  const params: IssuesSearchParams = {
    projects: componentKeys ?? projectKey,
    organization: auth.orgKey,
    severities: normalizedSeverities,
    impactSeverities: normalizedImpactSeverities,
    types: options.type,
    issueStatuses: normalizedStatuses,
    rules: options.rule,
    tags: options.tag,
    branch,
    pullRequest,
    resolved: options.resolved,
    sinceLeakPeriod: options.newCode,
    ps: options.pageSize,
    p: page,
  };

  const result = await issuesClient.searchIssues(params).orThrow();

  let output: string;

  switch (format) {
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

  console.print(output);
}

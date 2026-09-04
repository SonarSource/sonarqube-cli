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

// quality-gate status command - fetch the quality gate verdict for a project

import { CommandFailedError, InvalidOptionError } from '@/core/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveProjectKey } from '@/core/project-info.ts';
import { MAX_PAGE_SIZE, SonarQubeClient } from '@/core/server/client.ts';
import { MetricsClient } from '@/core/server/metrics.ts';
import { QualityGatesClient } from '@/core/server/quality-gates.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { print, warn } from '@/core/ui';

import {
  attachBreakdowns,
  hasFailingConditionInCategory,
  IMPLEMENTED_CATEGORIES,
} from './breakdown.ts';
import { selectConditions } from './condition-summary.ts';
import { formatQualityGateJson } from './format-json.ts';
import { formatQualityGateTable } from './format-table.ts';
import { resolveDisplayScope, resolveScopeQueryParams } from './scope.ts';
import { exitCodeFor, toVerdict } from './verdict.ts';

export const VALID_FORMATS = ['json', 'table'];

export const VALID_CATEGORIES = IMPLEMENTED_CATEGORIES;

export const DEFAULT_TOP = MAX_PAGE_SIZE;

export interface QualityGateStatusOptions {
  project?: string;
  format?: string;
  branch?: string;
  pullRequest?: string;
  all?: boolean;
  category?: string;
  top?: number;
}

export async function qualityGateStatus(
  options: QualityGateStatusOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth } = ctx;
  const top = options.top ?? DEFAULT_TOP;
  if (top < 1 || top > MAX_PAGE_SIZE) {
    throw new InvalidOptionError(
      `Invalid --top option: '${top}'. Must be an integer between 1 and ${MAX_PAGE_SIZE}`,
    );
  }
  if (options.category && !VALID_CATEGORIES.includes(options.category)) {
    throw new InvalidOptionError(
      `Invalid --category option: '${options.category}'. Must be one of: ${VALID_CATEGORIES.join(', ')}`,
    );
  }

  const projectKey = await resolveProjectKey(options.project, auth, true);
  noteProject(auth, projectKey);

  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  await assertProjectExists(client, projectKey);

  const queryParams = resolveScopeQueryParams(options);

  const qualityGatesClient = new QualityGatesClient(client);
  const [projectStatus, scope] = await Promise.all([
    qualityGatesClient.getProjectStatus({ projectKey, ...queryParams }),
    resolveDisplayScope(client, projectKey, options),
  ]);

  const rawConditions = projectStatus?.conditions ?? [];
  const hasFailingConditions = rawConditions.some((condition) => condition.status !== 'OK');
  const hasConditionsToRender = options.all ? rawConditions.length > 0 : hasFailingConditions;

  const metricsClient = new MetricsClient(client);
  const metrics = hasConditionsToRender ? await metricsClient.searchMetrics() : [];

  const verdict = toVerdict(projectStatus?.status);
  const summaries = selectConditions(rawConditions, metrics, options.all);
  const conditions = hasFailingConditions
    ? await attachBreakdowns(summaries, {
        client,
        projectKey,
        metrics,
        category: options.category,
        top,
        branch: queryParams.branch,
        pullRequest: queryParams.pullRequest,
      })
    : summaries;

  if (
    options.category &&
    hasFailingConditions &&
    !hasFailingConditionInCategory(rawConditions, options.category)
  ) {
    warn(`No failing conditions match category '${options.category}'.`);
  }

  const format = options.format ?? 'table';
  const message =
    format === 'table'
      ? formatQualityGateTable({ verdict, project: projectKey, scope, conditions })
      : formatQualityGateJson({ verdict, project: projectKey, scope, conditions });
  print(message);

  process.exitCode = exitCodeFor(verdict);
}

async function assertProjectExists(client: SonarQubeClient, projectKey: string): Promise<void> {
  if (!(await client.componentExists(projectKey))) {
    throw new CommandFailedError(`Project '${projectKey}' does not exist or not accessible.`, {
      remediationHint: 'Check the project key and your access to the project on the server.',
    });
  }
}

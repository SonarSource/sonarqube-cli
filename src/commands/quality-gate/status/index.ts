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

import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveFileComponentKey } from '@/core/file-component.ts';
import { resolveProjectKey } from '@/core/project-info.ts';
import { ComponentsClient } from '@/core/server/components.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { MetricsClient } from '@/core/server/metrics.ts';
import { MAX_PAGE_SIZE } from '@/core/server/projects.ts';
import { QualityGatesClient } from '@/core/server/quality-gates.ts';
import type { ProjectStatus } from '@/core/server/types.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import type { Console } from '@/core/ui/console.ts';

import {
  attachBreakdowns,
  hasFailingConditionInCategory,
  IMPLEMENTED_CATEGORIES,
  resolveEnrichableCategory,
} from './breakdown.ts';
import { selectConditions } from './condition-summary.ts';
import { fetchFileScopedConditions } from './file-scope-conditions.ts';
import { formatFileQualityGateJson, formatQualityGateJson } from './format-json.ts';
import { formatFileQualityGateTable, formatQualityGateTable } from './format-table.ts';
import { type QualityGateScope, resolveQualityGateScope } from './scope.ts';
import { exitCodeFor, type FileQualityGateVerdict, toFileVerdict, toVerdict } from './verdict.ts';

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
  file?: string;
}

interface ProjectResultParams {
  client: SonarHttpClient;
  projectKey: string;
  orgKey?: string;
  scope: QualityGateScope;
  branch?: string;
  pullRequest?: string;
  top: number;
  category?: string;
  all?: boolean;
  format: string;
  console: Console;
}

interface FileScopedResultParams {
  client: SonarHttpClient;
  projectKey: string;
  orgKey?: string;
  scope: QualityGateScope;
  branch?: string;
  pullRequest?: string;
  top: number;
  category?: string;
  all?: boolean;
  format: string;
  console: Console;
}

interface QualityGateResult {
  message: string;
  verdict: FileQualityGateVerdict;
}

export async function qualityGateStatus(
  options: QualityGateStatusOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth, console } = ctx;
  const top = options.top ?? DEFAULT_TOP;
  const format = options.format ?? 'table';
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

  const projectKey = await resolveProjectKey(options.project, auth, console, true);
  noteProject(auth, projectKey);

  const client = new SonarHttpClient(auth.serverUrl, auth.token);
  await assertProjectExists(client, projectKey);

  const { queryParams, scope } = await resolveQualityGateScope(client, projectKey, options);

  let result: QualityGateResult;
  if (options.file) {
    result = await buildFileScopedResult(options.file, {
      client,
      projectKey,
      orgKey: auth.orgKey,
      scope,
      branch: queryParams.branch,
      pullRequest: queryParams.pullRequest,
      top,
      category: options.category,
      all: options.all,
      format,
      console,
    });
  } else {
    result = await buildProjectResult({
      client,
      projectKey,
      orgKey: auth.orgKey,
      scope,
      branch: queryParams.branch,
      pullRequest: queryParams.pullRequest,
      top,
      category: options.category,
      all: options.all,
      format,
      console,
    });
  }

  console.print(result.message);
  process.exitCode = exitCodeFor(result.verdict);
}

async function assertProjectExists(client: SonarHttpClient, projectKey: string): Promise<void> {
  if (!(await new ComponentsClient(client).componentExists(projectKey).orThrow())) {
    throw new CommandFailedError(`Project '${projectKey}' does not exist or not accessible.`, {
      remediationHint: 'Check the project key and your access to the project on the server.',
    });
  }
}

async function buildProjectResult(params: ProjectResultParams): Promise<QualityGateResult> {
  const projectStatus = await fetchProjectStatus(
    params.client,
    params.projectKey,
    params.branch,
    params.pullRequest,
  );
  const rawConditions = projectStatus?.conditions ?? [];
  const hasFailingConditions = rawConditions.some((condition) => condition.status !== 'OK');
  const hasConditionsToRender = params.all ? rawConditions.length > 0 : hasFailingConditions;

  const metricsClient = new MetricsClient(params.client);
  const metrics = hasConditionsToRender ? await metricsClient.searchMetrics().orThrow() : [];

  const verdict = toVerdict(projectStatus?.status);
  const summaries = selectConditions(rawConditions, metrics, params.all);
  const conditions = hasFailingConditions
    ? await attachBreakdowns(summaries, {
        client: params.client,
        projectKey: params.projectKey,
        orgKey: params.orgKey,
        metrics,
        category: params.category,
        top: params.top,
        branch: params.branch,
        pullRequest: params.pullRequest,
      })
    : summaries;

  if (
    params.category &&
    hasFailingConditions &&
    !hasFailingConditionInCategory(rawConditions, params.category)
  ) {
    params.console.warn(`No failing conditions match category '${params.category}'.`);
  }

  const message =
    params.format === 'table'
      ? formatQualityGateTable({
          verdict,
          project: params.projectKey,
          scope: params.scope,
          conditions,
        })
      : formatQualityGateJson({
          verdict,
          project: params.projectKey,
          scope: params.scope,
          conditions,
        });

  return { message, verdict };
}

async function buildFileScopedResult(
  file: string,
  params: FileScopedResultParams,
): Promise<QualityGateResult> {
  const componentKey = await resolveFileComponentKey(params.client, params.projectKey, file, {
    branch: params.branch,
    pullRequest: params.pullRequest,
  });

  const projectStatus = await fetchProjectStatus(
    params.client,
    params.projectKey,
    params.branch,
    params.pullRequest,
  );
  const projectVerdict = toVerdict(projectStatus?.status);
  const rawConditions = projectStatus?.conditions ?? [];

  const metricsClient = new MetricsClient(params.client);
  const metrics = rawConditions.length > 0 ? await metricsClient.searchMetrics().orThrow() : [];

  const fileConditions = await fetchFileScopedConditions(rawConditions, {
    client: params.client,
    projectKey: params.projectKey,
    componentKey,
    orgKey: params.orgKey,
    metrics,
    category: params.category,
    top: params.top,
    branch: params.branch,
    pullRequest: params.pullRequest,
  });
  const conditions = params.all
    ? fileConditions
    : fileConditions.filter((c) => c.status === 'ERROR');
  const verdict = toFileVerdict(projectVerdict, fileConditions);

  if (
    params.category &&
    fileConditions.some((c) => c.status === 'ERROR') &&
    !fileConditions.some((c) => resolveEnrichableCategory(c, params.category))
  ) {
    params.console.warn(`No failing conditions match category '${params.category}'.`);
  }

  const viewModel = { file, verdict, scope: params.scope, conditions };
  const message =
    params.format === 'table'
      ? formatFileQualityGateTable(viewModel)
      : formatFileQualityGateJson(viewModel);

  return { message, verdict };
}

async function fetchProjectStatus(
  client: SonarHttpClient,
  projectKey: string,
  branch: string | undefined,
  pullRequest: string | undefined,
): Promise<ProjectStatus | null> {
  return new QualityGatesClient(client)
    .getProjectStatus({ projectKey, branch, pullRequest })
    .orThrow();
}

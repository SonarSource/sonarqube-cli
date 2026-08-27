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

// Get quality-gate command - fetch the quality gate verdict for a project

import type { CommandAuthenticatedInvocationContext } from '@/commands/command-invocation-context.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import { resolveProjectKey } from '@/core/project-info.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import { MetricsClient } from '@/core/server/metrics.ts';
import { QualityGatesClient } from '@/core/server/quality-gates.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { print } from '@/core/ui';

import { selectConditions } from './condition-summary.ts';
import { formatQualityGateJson } from './format-json.ts';
import { formatQualityGateTable } from './format-table.ts';
import { resolveDisplayScope, resolveScopeQueryParams } from './scope.ts';
import { exitCodeFor, toVerdict } from './verdict.ts';

export const VALID_FORMATS = ['json', 'table'];

export interface GetQualityGateOptions {
  project?: string;
  format?: string;
  branch?: string;
  pullRequest?: string;
  all?: boolean;
}

export async function getQualityGate(
  options: GetQualityGateOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth } = ctx;
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
  const hasConditionsToRender = options.all
    ? rawConditions.length > 0
    : rawConditions.some((condition) => condition.status !== 'OK');

  const metricsClient = new MetricsClient(client);
  const metrics = hasConditionsToRender ? await metricsClient.searchMetrics() : [];

  const verdict = toVerdict(projectStatus?.status);
  const conditions = selectConditions(rawConditions, metrics, options.all);

  const format = options.format ?? 'json';
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

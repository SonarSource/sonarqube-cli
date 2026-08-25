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
import { resolveProjectKey } from '@/core/project-info.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import { QualityGatesClient } from '@/core/server/quality-gates.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { print } from '@/core/ui';

import { selectConditions } from './quality-gate-helpers/condition-summary.ts';
import { formatQualityGateJson } from './quality-gate-helpers/format-json.ts';
import { formatQualityGateTable } from './quality-gate-helpers/format-table.ts';
import { resolveQualityGateScope, scopeQueryParams } from './quality-gate-helpers/scope.ts';
import { exitCodeFor, toVerdict } from './quality-gate-helpers/verdict.ts';

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
  const scope = await resolveQualityGateScope(client, projectKey, options);

  const qualityGatesClient = new QualityGatesClient(client);
  const projectStatus = await qualityGatesClient.getProjectStatus({
    projectKey,
    ...scopeQueryParams(scope),
  });

  const verdict = toVerdict(projectStatus?.status);
  const conditions = selectConditions(projectStatus?.conditions, options.all);

  const format = options.format ?? 'json';
  const message =
    format === 'table'
      ? formatQualityGateTable({ verdict, project: projectKey, scope, conditions })
      : formatQualityGateJson({ verdict, project: projectKey, scope, conditions });
  print(message);

  process.exitCode = exitCodeFor(verdict);
}

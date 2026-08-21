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

export const EXIT_CODE_QUALITY_GATE_FAILED = 51;

export interface GetQualityGateOptions {
  project?: string;
}

type QualityGateVerdict = 'OK' | 'ERROR' | 'NOT_COMPUTED';

/**
 * `WARN` is a legacy status; it and `ERROR` both bucket to "failed" since the CLI only
 * surfaces the three-way pass/fail/not-computed verdict at this stage.
 */
function toVerdict(status: 'OK' | 'WARN' | 'ERROR' | 'NONE' | undefined): QualityGateVerdict {
  if (!status || status === 'NONE') {
    return 'NOT_COMPUTED';
  }
  return status === 'OK' ? 'OK' : 'ERROR';
}

function exitCodeFor(verdict: QualityGateVerdict): number {
  switch (verdict) {
    case 'OK':
      return 0;
    case 'ERROR':
      return EXIT_CODE_QUALITY_GATE_FAILED;
    case 'NOT_COMPUTED':
      return 1;
  }
}

export async function getQualityGate(
  options: GetQualityGateOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth } = ctx;
  const projectKey = await resolveProjectKey(options.project, auth, true);
  noteProject(auth, projectKey);

  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  const qualityGatesClient = new QualityGatesClient(client);
  const projectStatus = await qualityGatesClient.getProjectStatus({ projectKey });

  const verdict = toVerdict(projectStatus?.status);

  print(JSON.stringify({ qualityGate: { status: verdict, project: projectKey } }, null, 2));

  process.exitCode = exitCodeFor(verdict);
}

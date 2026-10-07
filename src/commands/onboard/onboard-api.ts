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
import { DEFAULT_ANALYSIS_TIMEOUT_SECONDS, pollUntil, waitDeadline } from '@/core/commands/poll.ts';
import { ComponentsClient } from '@/core/server/components.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';

interface ComputeTask {
  id: string;
  componentKey?: string;
  status: string;
  analysisId?: string;
  errorMessage?: string;
}

export class OnboardApiClient {
  readonly components: ComponentsClient;

  constructor(private readonly http: SonarHttpClient) {
    this.components = new ComponentsClient(http);
  }

  createProject(projectKey: string, name: string, organization?: string) {
    return this.http.postFormJson<{ project: { key: string; name: string } }>(
      '/api/projects/create',
      {
        project: projectKey,
        name,
        visibility: 'private',
        ...(organization ? { organization } : {}),
      },
    );
  }

  async waitForAnalysis(taskId: string, projectKey: string): Promise<string> {
    return pollUntil(
      async () => {
        const { task } = await this.http
          .get<{ task: ComputeTask }>('/api/ce/task', { id: taskId })
          .orThrow();
        if (task.id !== taskId || (task.componentKey && task.componentKey !== projectKey)) {
          throw new CommandFailedError('The analysis task does not match the onboarded project.');
        }
        if (task.status === 'FAILED' || task.status === 'CANCELED') {
          throw new CommandFailedError(
            `Analysis processing ${task.status.toLowerCase()}: ${task.errorMessage ?? taskId}`,
          );
        }
        if (task.status === 'SUCCESS') {
          if (!task.analysisId)
            throw new CommandFailedError('The completed analysis has no analysis ID.');
          return task.analysisId;
        }
        if (task.status !== 'PENDING' && task.status !== 'IN_PROGRESS') {
          throw new CommandFailedError('The server returned an unknown analysis task status.');
        }
        return undefined;
      },
      waitDeadline(DEFAULT_ANALYSIS_TIMEOUT_SECONDS),
      `Analysis '${taskId}' is still processing. Check the project dashboard.`,
    );
  }

  async qualityGate(analysisId: string): Promise<string> {
    const response = await this.http
      .get<{ projectStatus: { status: string } }>('/api/qualitygates/project_status', {
        analysisId,
      })
      .orThrow();
    return response.projectStatus.status;
  }
}

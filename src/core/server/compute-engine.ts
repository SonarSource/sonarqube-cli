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

// SonarQube Compute Engine API wrapper

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { pollUntil } from '@/core/commands/poll.ts';

import type { SonarHttpClient } from './http-client.ts';

interface ComputeTask {
  id: string;
  componentKey?: string;
  status: string;
  analysisId?: string;
  errorMessage?: string;
}

export class ComputeEngineClient {
  constructor(private readonly client: SonarHttpClient) {}

  /**
   * Waits until the server has processed the analysis task and resolves to its analysis id.
   * Rejects when the task failed or was canceled, or when it is still running at `deadline`.
   */
  waitForAnalysis(taskId: string, projectKey: string, deadline: number): Promise<string> {
    return pollUntil(
      async () => {
        const { task } = await this.client
          .get<{ task: ComputeTask }>('/api/ce/task', { id: taskId })
          .orThrow();
        if (task.id !== taskId || (task.componentKey && task.componentKey !== projectKey)) {
          throw new CommandFailedError('The analysis task does not match the project.');
        }
        if (task.status === 'FAILED' || task.status === 'CANCELED') {
          throw new CommandFailedError(
            `Analysis processing ${task.status.toLowerCase()}: ${task.errorMessage ?? taskId}`,
          );
        }
        if (task.status === 'SUCCESS') {
          if (!task.analysisId) {
            throw new CommandFailedError('The completed analysis has no analysis ID.');
          }
          return task.analysisId;
        }
        if (task.status !== 'PENDING' && task.status !== 'IN_PROGRESS') {
          throw new CommandFailedError('The server returned an unknown analysis task status.');
        }
        return undefined;
      },
      deadline,
      `Analysis '${taskId}' is still being processed by the server.`,
    );
  }
}

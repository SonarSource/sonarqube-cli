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

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { RemediateApiClient } from '@/commands/remediate/remediate-api.ts';
import {
  SONARCLOUD_API_URL,
  SONARCLOUD_URL,
  SONARCLOUD_US_API_URL,
  SONARCLOUD_US_URL,
} from '@/core/config-constants.ts';
import { ForbiddenApiError } from '@/core/server/errors.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { lastFetchInit, lastFetchUrl, mockFetch } from '../../helpers/mock-fetch.ts';

const TOKEN = 'squ_test_token';

describe('RemediateApiClient', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('scheduleAgentJob', () => {
    it('sends POST to SONARCLOUD_API_URL for EU Cloud', async () => {
      const cloudClient = new RemediateApiClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      fetchSpy = mockFetch({ taskId: 'task-abc' });
      await cloudClient.scheduleAgentJob({
        projectId: 'proj-id',
        issueKeys: ['KEY-1'],
        triggerSource: 'CLI',
      });
      expect(lastFetchUrl(fetchSpy)).toBe(
        `${SONARCLOUD_API_URL}/fix-suggestions/ai-agent-scheduled-jobs`,
      );
    });

    it('sends POST to SONARCLOUD_US_API_URL for US Cloud', async () => {
      const usClient = new RemediateApiClient(new SonarHttpClient(SONARCLOUD_US_URL, TOKEN));
      fetchSpy = mockFetch({ taskId: 'task-abc' });
      await usClient.scheduleAgentJob({
        projectId: 'proj-id',
        issueKeys: ['KEY-1'],
        triggerSource: 'CLI',
      });
      expect(lastFetchUrl(fetchSpy)).toBe(
        `${SONARCLOUD_US_API_URL}/fix-suggestions/ai-agent-scheduled-jobs`,
      );
    });

    it('sends projectId, issueKeys, and triggerSource in the JSON body', async () => {
      const cloudClient = new RemediateApiClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      fetchSpy = mockFetch({ taskId: 'task-abc' });
      await cloudClient.scheduleAgentJob({
        projectId: 'proj-id',
        issueKeys: ['KEY-1', 'KEY-2'],
        triggerSource: 'CLI',
      });
      const body = JSON.parse(lastFetchInit(fetchSpy).body as string) as {
        projectId: string;
        issueKeys: string[];
        triggerSource: string;
      };
      expect(body.projectId).toBe('proj-id');
      expect(body.issueKeys).toEqual(['KEY-1', 'KEY-2']);
      expect(body.triggerSource).toBe('CLI');
    });

    it('returns the parsed taskId from the response', async () => {
      const cloudClient = new RemediateApiClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      fetchSpy = mockFetch({ taskId: 'task-xyz-789' });
      const result = await cloudClient.scheduleAgentJob({
        projectId: 'proj-id',
        issueKeys: ['KEY-1'],
        triggerSource: 'CLI',
      });
      expect(result.taskId).toBe('task-xyz-789');
    });

    it('throws ForbiddenApiError on 403 response', async () => {
      const cloudClient = new RemediateApiClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      fetchSpy = mockFetch({ message: 'Insufficient privileges' }, { ok: false, status: 403 });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        cloudClient.scheduleAgentJob({
          projectId: 'proj-id',
          issueKeys: ['KEY-1'],
          triggerSource: 'CLI',
        }),
      ).rejects.toBeInstanceOf(ForbiddenApiError);
    });
  });
});

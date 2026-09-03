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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { SqaaAnalysisClient } from '@/commands/analyze/sqaa-analysis-client.ts';
import {
  SONARCLOUD_API_URL,
  SONARCLOUD_URL,
  SONARCLOUD_US_API_URL,
  SONARCLOUD_US_URL,
} from '@/core/config-constants.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { INVOCATION_ID } from '@/core/telemetry/invocation-id.ts';

import { lastFetchInit, lastFetchUrl, mockFetch } from '../../helpers/mock-fetch.ts';

const SERVER_URL = 'https://sonarqube.example.com';
const TOKEN = 'squ_test_token';

describe('SqaaAnalysisClient', () => {
  let client: SqaaAnalysisClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new SqaaAnalysisClient(new SonarHttpClient(SERVER_URL, TOKEN));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('createAnalysis', () => {
    const singleFileRequest = {
      organizationKey: 'my-org',
      projectKey: 'my-project',
      files: [{ path: 'src/index.ts', content: 'const x = 1;' }],
    };

    it('sends POST to SONARCLOUD_API_URL for EU Cloud', async () => {
      const cloudClient = new SqaaAnalysisClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await cloudClient.createAnalysis(singleFileRequest);

      const url = lastFetchUrl(fetchSpy);
      expect(url).toBe(`${SONARCLOUD_API_URL}/a3s-analysis/analyses`);
    });

    it('sends POST to SONARCLOUD_US_API_URL for US Cloud', async () => {
      const usClient = new SqaaAnalysisClient(new SonarHttpClient(SONARCLOUD_US_URL, TOKEN));
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await usClient.createAnalysis(singleFileRequest);

      const url = lastFetchUrl(fetchSpy);
      expect(url).toBe(`${SONARCLOUD_US_API_URL}/a3s-analysis/analyses`);
    });

    it('sends POST to the instance /api/v2 path on SonarQube Server', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.createAnalysis(singleFileRequest);

      const url = lastFetchUrl(fetchSpy);
      expect(url).toBe(`${SERVER_URL}/api/v2/a3s/analyses`);
    });

    it('sends Bearer token in Authorization header', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.createAnalysis(singleFileRequest);

      const init = lastFetchInit(fetchSpy);
      expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    });

    it('sends x-sonar-invocation-id header from INVOCATION_ID', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.createAnalysis(singleFileRequest);

      expect(lastFetchInit(fetchSpy).headers).toMatchObject({
        'x-sonar-invocation-id': INVOCATION_ID,
      });
    });

    it('sends request body as JSON with files[]', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.createAnalysis(singleFileRequest);

      const init = lastFetchInit(fetchSpy);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.organizationKey).toBe('my-org');
      expect(body.projectKey).toBe('my-project');
      expect(body.files).toEqual([{ path: 'src/index.ts', content: 'const x = 1;' }]);
      expect(body.analysisDepth).toBeUndefined();
    });

    it('does not include branchName in body when not provided', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.createAnalysis(singleFileRequest);

      const init = lastFetchInit(fetchSpy);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.branchName).toBeUndefined();
    });

    it('includes branchName in body when provided', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.createAnalysis({
        ...singleFileRequest,
        branchName: 'feature/my-branch',
      });

      const init = lastFetchInit(fetchSpy);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.branchName).toBe('feature/my-branch');
    });

    it('includes analysisDepth when provided', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.createAnalysis({
        ...singleFileRequest,
        analysisDepth: 'DEEP',
      });

      const init = lastFetchInit(fetchSpy);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.analysisDepth).toBe('DEEP');
    });

    it('returns parsed response', async () => {
      const mockResponse = {
        id: 'analysis-123',
        issues: [{ rule: 'ts:S1234', message: 'Fix this', textRange: null }],
        errors: null,
      };
      fetchSpy = mockFetch(mockResponse);

      const result = await client.createAnalysis(singleFileRequest);

      expect(result.id).toBe('analysis-123');
      expect(result.issues).toHaveLength(1);
    });

    it('throws BadRequestError on structured 400 response', async () => {
      fetchSpy = mockFetch(
        { message: 'Invalid request body', code: 'INVALID_FILE_PATH' },
        { ok: false, status: 400 },
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.createAnalysis(singleFileRequest)).rejects.toMatchObject({
        name: 'BadRequestError',
        message: 'Invalid request body',
        code: 'INVALID_FILE_PATH',
      });
    });

    it('throws RequestPayloadTooLargeError on structured 413 response', async () => {
      fetchSpy = mockFetch(
        {
          message: 'Request payload too large',
          code: 'REQUEST_TOO_LARGE',
          meta: { maxRequestSize: 512_000 },
        },
        { ok: false, status: 413 },
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.createAnalysis(singleFileRequest)).rejects.toMatchObject({
        name: 'RequestPayloadTooLargeError',
        message: 'Request payload too large',
        code: 'REQUEST_TOO_LARGE',
        meta: { maxRequestSize: 512_000 },
      });
    });
  });
});

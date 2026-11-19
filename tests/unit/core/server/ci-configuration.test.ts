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

import {
  CiConfigurationClient,
  type CreateCiConfigurationRunRequest,
  isTerminalCiRunStatus,
} from '@/core/server/ci-configuration.ts';
import { BadRequestError, ForbiddenApiError } from '@/core/server/errors.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { lastFetchInit, lastFetchUrl, mockFetch, mockFetchSeq } from '../../helpers/mock-fetch.ts';

const SERVER_URL = 'https://sonarqube.example.com';
const RUNS_URL = `${SERVER_URL}/api/v2/onboarding/ci-configuration/runs`;
const CAPABILITIES_URL = `${SERVER_URL}/api/v2/onboarding/ci-configuration/capabilities`;
const GITLAB_TOKEN = 'glpat-super-secret';

const REQUEST: CreateCiConfigurationRunRequest = {
  provider: 'GITLAB',
  selection: { groupPath: 'acme', repoPaths: ['team/svc'] },
  options: { triggerOn: 'BOTH' },
  dryRun: false,
  credential: { type: 'PERSONAL_ACCESS_TOKEN', token: GITLAB_TOKEN },
};

describe('CiConfigurationClient', () => {
  let client: CiConfigurationClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new CiConfigurationClient(new SonarHttpClient(SERVER_URL, 'squ_token'));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('createRun', () => {
    it('POSTs the request as JSON and returns the run id', async () => {
      fetchSpy = mockFetch({ id: 'run-1', status: 'QUEUED' }, { status: 202 });

      const response = await client.createRun(REQUEST).orThrow();

      expect(response).toEqual({ id: 'run-1', status: 'QUEUED' });
      expect(lastFetchUrl(fetchSpy)).toBe(RUNS_URL);
      const init = lastFetchInit(fetchSpy);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual(REQUEST);
    });

    it('keeps the GitLab token out of the URL and headers', async () => {
      fetchSpy = mockFetch({ id: 'run-1', status: 'QUEUED' }, { status: 202 });

      await client.createRun(REQUEST).orThrow();

      expect(lastFetchUrl(fetchSpy)).not.toContain(GITLAB_TOKEN);
      expect(JSON.stringify(lastFetchInit(fetchSpy).headers)).not.toContain(GITLAB_TOKEN);
    });

    it('surfaces a 400 as BadRequestError carrying the server message', async () => {
      fetchSpy = mockFetch({ message: 'No GitLab configuration found' }, { status: 400 });

      const result = await client.createRun(REQUEST);

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error).toBeInstanceOf(BadRequestError);
      expect(error.message).toBe('No GitLab configuration found');
    });

    it('surfaces a 403 as ForbiddenApiError', async () => {
      fetchSpy = mockFetch('forbidden', { status: 403 });

      const result = await client.createRun(REQUEST);

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(ForbiddenApiError);
    });
  });

  describe('getRun', () => {
    it('GETs the run by id', async () => {
      fetchSpy = mockFetch({ id: 'run-1', status: 'RUNNING', counts: { total: 3 } });

      expect(await client.getRun('run-1').orThrow()).toMatchObject({
        id: 'run-1',
        status: 'RUNNING',
      });
      expect(lastFetchUrl(fetchSpy)).toBe(`${RUNS_URL}/run-1`);
    });

    it('URL-encodes the run id', async () => {
      fetchSpy = mockFetch({ id: 'a/b' });
      await client.getRun('a/b').orThrow();
      expect(lastFetchUrl(fetchSpy)).toBe(`${RUNS_URL}/a%2Fb`);
    });

    it('fails for an unknown run', async () => {
      fetchSpy = mockFetch({}, { status: 404 });
      expect((await client.getRun('nope')).isErr()).toBe(true);
    });
  });

  describe('getRunItems', () => {
    it('passes paging parameters', async () => {
      const page = { items: [], page: { pageIndex: 2, pageSize: 50, total: 120 } };
      fetchSpy = mockFetch(page);

      expect(await client.getRunItems('run-1', 2, 50).orThrow()).toEqual(page);
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/v2/onboarding/ci-configuration/runs/run-1/items');
      expect(url.searchParams.get('pageIndex')).toBe('2');
      expect(url.searchParams.get('pageSize')).toBe('50');
      expect(url.searchParams.has('status')).toBe(false);
    });

    it('passes the status filter when given', async () => {
      fetchSpy = mockFetch({ items: [], page: { pageIndex: 1, pageSize: 50, total: 0 } });
      await client.getRunItems('run-1', 1, 50, 'FAILED').orThrow();
      expect(new URL(lastFetchUrl(fetchSpy)).searchParams.get('status')).toBe('FAILED');
    });
  });

  describe('cancelRun', () => {
    it('POSTs to the cancel endpoint and accepts an empty 204 response', async () => {
      fetchSpy = mockFetchSeq(new Response(null, { status: 204 }));

      await client.cancelRun('run-1').orThrow();

      expect(lastFetchUrl(fetchSpy)).toBe(`${RUNS_URL}/run-1/cancel`);
      expect(lastFetchInit(fetchSpy).method).toBe('POST');
    });

    it('fails for an unknown run', async () => {
      fetchSpy = mockFetch('not found', { status: 404 });
      expect((await client.cancelRun('nope')).isErr()).toBe(true);
    });
  });

  describe('getCapabilities', () => {
    it('GETs the capabilities endpoint and returns the flags', async () => {
      const body = { runs: true, status: true, providers: ['GITLAB'] };
      fetchSpy = mockFetch(body);

      expect(await client.getCapabilities().orThrow()).toEqual(body);
      expect(lastFetchUrl(fetchSpy)).toBe(CAPABILITIES_URL);
    });

    it.each([403, 404, 405])('is null on %i', async (status) => {
      fetchSpy = mockFetch({}, { status });
      expect(await client.getCapabilities().orThrow()).toBeNull();
    });

    it('defaults missing fields to disabled', async () => {
      fetchSpy = mockFetch({});
      expect(await client.getCapabilities().orThrow()).toEqual({
        runs: false,
        status: false,
        providers: [],
      });
    });
  });

  describe('probeSupport', () => {
    it('is true when runs are enabled and GITLAB is supported', async () => {
      fetchSpy = mockFetch({ runs: true, status: true, providers: ['GITLAB'] });

      expect(await client.probeSupport().orThrow()).toBe(true);
      expect(new URL(lastFetchUrl(fetchSpy)).pathname).toBe(
        '/api/v2/onboarding/ci-configuration/capabilities',
      );
    });

    it('is false when runs are disabled', async () => {
      fetchSpy = mockFetch({ runs: false, status: true, providers: ['GITLAB'] });
      expect(await client.probeSupport().orThrow()).toBe(false);
    });

    it('is false when GITLAB is not a supported provider', async () => {
      fetchSpy = mockFetch({ runs: true, status: true, providers: ['GITHUB'] });
      expect(await client.probeSupport().orThrow()).toBe(false);
    });

    it.each([403, 404, 405])('is false on %i', async (status) => {
      fetchSpy = mockFetch({}, { status });
      expect(await client.probeSupport().orThrow()).toBe(false);
    });

    it('propagates a 500', async () => {
      fetchSpy = mockFetch('boom', { ok: false, status: 500 });
      expect((await client.probeSupport()).isErr()).toBe(true);
    });

    it('propagates a 401', async () => {
      fetchSpy = mockFetch({}, { status: 401 });
      expect((await client.probeSupport()).isErr()).toBe(true);
    });

    it('propagates a network failure', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'));
      const result = await client.probeSupport();
      expect(result._unsafeUnwrapErr().message).toContain('connection refused');
    });
  });
});

describe('isTerminalCiRunStatus', () => {
  it.each(['COMPLETED', 'FAILED', 'CANCELLED'] as const)('treats %s as terminal', (status) => {
    expect(isTerminalCiRunStatus(status)).toBe(true);
  });

  it.each(['QUEUED', 'RUNNING'] as const)('treats %s as non-terminal', (status) => {
    expect(isTerminalCiRunStatus(status)).toBe(false);
  });
});

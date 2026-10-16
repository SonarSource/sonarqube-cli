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

import { ServerImportApiClient } from '@/commands/import/server/server-import-api.ts';
import { AccessDeniedError, BadRequestError, ServerError } from '@/core/server/errors.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import {
  fakeResponse,
  lastFetchInit,
  lastFetchUrl,
  mockFetch,
  mockFetchSeq,
} from '../../../helpers/mock-fetch.ts';

const SERVER_URL = 'https://sonarqube.example.com';

/** A 204 as `fetch` returns it: ok, with a body that is not JSON. */
function noContentResponse(): Response {
  return {
    ok: true,
    status: 204,
    statusText: 'No Content',
    json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    text: () => Promise.resolve(''),
    headers: new Headers(),
  } as Response;
}

function badRequest(message: string): Response {
  return fakeResponse({ errors: [{ msg: message }] }, { status: 400 });
}

describe('ServerImportApiClient', () => {
  let api: ServerImportApiClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    api = new ServerImportApiClient(new SonarHttpClient(SERVER_URL, 'squ_token'));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('listDopSettings', () => {
    it('calls the v2 dop-settings endpoint', async () => {
      fetchSpy = mockFetch({ dopSettings: [] });
      await api.listDopSettings();
      expect(new URL(lastFetchUrl(fetchSpy)).pathname).toBe('/api/v2/dop-translation/dop-settings');
    });

    it('maps settings of every supported platform', async () => {
      fetchSpy = mockFetch({
        dopSettings: [
          { id: '1', key: 'gh', type: 'github', url: 'https://api.github.com', appId: 'x' },
          { id: '2', key: 'gl', type: 'gitlab', url: 'https://gitlab.com' },
          { id: '3', key: 'az', type: 'azure', url: 'https://dev.azure.com/org' },
          { id: '4', key: 'bbs', type: 'bitbucket', url: 'https://bbs.example.com' },
          { id: '5', key: 'bbc', type: 'bitbucketcloud', url: null },
        ],
      });
      expect(await api.listDopSettings()).toEqual([
        { id: '1', key: 'gh', type: 'github', url: 'https://api.github.com' },
        { id: '2', key: 'gl', type: 'gitlab', url: 'https://gitlab.com' },
        { id: '3', key: 'az', type: 'azure', url: 'https://dev.azure.com/org' },
        { id: '4', key: 'bbs', type: 'bitbucket', url: 'https://bbs.example.com' },
        { id: '5', key: 'bbc', type: 'bitbucketcloud' },
      ]);
    });

    it('leaves out platforms the CLI does not know', async () => {
      fetchSpy = mockFetch({
        dopSettings: [
          { id: '1', key: 'future', type: 'somethingnew', url: 'https://x.example.com' },
          { id: '2', key: 'gl', type: 'gitlab', url: 'https://gitlab.com' },
        ],
      });
      const settings = await api.listDopSettings();
      expect(settings.map((s) => s.key)).toEqual(['gl']);
    });

    it('returns an empty list when nothing is configured', async () => {
      fetchSpy = mockFetch({ dopSettings: [] });
      expect(await api.listDopSettings()).toEqual([]);
    });

    it('rejects when the endpoint is missing (older server)', async () => {
      fetchSpy = mockFetch({}, { status: 404 });
      const error = await api.listDopSettings().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AccessDeniedError);
      expect((error as AccessDeniedError).status).toBe(404);
    });
  });

  describe.each([
    ['checkPat', '/api/alm_integration/check_pat'],
    ['probeGithubPat', '/api/alm_integration/list_github_organizations'],
  ] as const)('%s', (method, path) => {
    it('sends the setting key as almSetting, and nothing token-like', async () => {
      fetchSpy = mockFetchSeq(noContentResponse());
      await api[method]('my-setting');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe(path);
      expect([...url.searchParams.keys()]).toEqual(['almSetting']);
      expect(url.searchParams.get('almSetting')).toBe('my-setting');
      expect(lastFetchInit(fetchSpy).method).toBe('GET');
    });

    it('is valid on an empty 2xx', async () => {
      fetchSpy = mockFetchSeq(noContentResponse());
      expect(await api[method]('s')).toBe('valid');
    });

    it('is valid on a JSON 200', async () => {
      fetchSpy = mockFetch({ organizations: [] });
      expect(await api[method]('s')).toBe('valid');
    });

    it('is missing when the server says the token is missing', async () => {
      fetchSpy = mockFetchSeq(badRequest("personal access token for 's' is missing"));
      expect(await api[method]('s')).toBe('missing');
    });

    it('is missing for the GitLab capitalisation', async () => {
      fetchSpy = mockFetchSeq(badRequest("Personal access token for 's' Is Missing"));
      expect(await api[method]('s')).toBe('missing');
    });

    it('is invalid when the platform rejects the token', async () => {
      fetchSpy = mockFetchSeq(badRequest('Invalid personal access token'));
      expect(await api[method]('s')).toBe('invalid');
    });

    it('rejects with the original error on a 400 that is not about the token', async () => {
      fetchSpy = mockFetchSeq(badRequest('Unable to contact Bitbucket server'));
      const error = await api[method]('s').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestError);
    });

    it('rejects with the original error when the status is not about the token', async () => {
      fetchSpy = mockFetchSeq(fakeResponse({}, { status: 403 }));
      const error = await api[method]('s').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AccessDeniedError);
      expect((error as AccessDeniedError).status).toBe(403);
    });

    it('rejects on a server error rather than calling the token invalid', async () => {
      fetchSpy = mockFetchSeq(fakeResponse({}, { status: 500 }));
      const error = await api[method]('s').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServerError);
    });
  });

  it('probeGithubPat is missing on "No personal access token found"', async () => {
    fetchSpy = mockFetchSeq(badRequest('No personal access token found'));
    expect(await api.probeGithubPat('gh')).toBe('missing');
  });
});

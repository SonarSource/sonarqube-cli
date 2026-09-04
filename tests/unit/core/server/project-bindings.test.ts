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

import { SONARCLOUD_API_URL, SONARCLOUD_URL } from '@/core/config-constants.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { ProjectBindingsClient } from '@/core/server/project-bindings.ts';

import { lastFetchUrl, mockFetch } from '../../helpers/mock-fetch.ts';

const SERVER_URL = 'https://sonarqube.example.com';
const TOKEN = 'squ_test_token';

describe('ProjectBindingsClient', () => {
  let client: ProjectBindingsClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new ProjectBindingsClient(new SonarHttpClient(SERVER_URL, TOKEN));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('getProjectKeyByGitRemote', () => {
    const remoteUrl = 'https://github.com/foo/bar.git';

    it('returns projectKey from SQS project-bindings API', async () => {
      fetchSpy = mockFetch({
        projectBindings: [{ projectId: 'proj:123', projectKey: 'my-project' }],
      });
      const key = await client.getProjectKeyByGitRemote(remoteUrl);
      expect(key).toBe('my-project');
      expect(lastFetchUrl(fetchSpy)).toBe(
        `${SERVER_URL}/api/v2/dop-translation/project-bindings?repositoryUrl=${encodeURIComponent(remoteUrl)}`,
      );
    });

    it('returns null when SQS has no bindings', async () => {
      fetchSpy = mockFetch({ projectBindings: [] });
      expect(await client.getProjectKeyByGitRemote(remoteUrl)).toBeNull();
    });

    it('returns null when SQS has multiple bindings', async () => {
      fetchSpy = mockFetch({
        projectBindings: [
          { projectId: 'proj:1', projectKey: 'project-a' },
          { projectId: 'proj:2', projectKey: 'project-b' },
        ],
      });
      expect(await client.getProjectKeyByGitRemote(remoteUrl)).toBeNull();
    });

    it('strips embedded credentials from the remote before calling SQS', async () => {
      const remoteWithCredentials = 'https://user:token@github.com/foo/bar.git';
      const sanitizedRemote = 'https://github.com/foo/bar.git';
      fetchSpy = mockFetch({
        projectBindings: [{ projectId: 'proj:123', projectKey: 'my-project' }],
      });
      const key = await client.getProjectKeyByGitRemote(remoteWithCredentials);
      expect(key).toBe('my-project');
      expect(lastFetchUrl(fetchSpy)).toBe(
        `${SERVER_URL}/api/v2/dop-translation/project-bindings?repositoryUrl=${encodeURIComponent(sanitizedRemote)}`,
      );
    });

    it('returns null when SQS project-bindings request fails', async () => {
      fetchSpy = mockFetch({ message: 'not found' }, { ok: false, status: 404 });
      expect(await client.getProjectKeyByGitRemote(remoteUrl)).toBeNull();
    });

    it('returns null when SQS binding has no projectKey', async () => {
      fetchSpy = mockFetch({
        projectBindings: [{ projectId: 'proj:123', projectKey: '' }],
      });
      expect(await client.getProjectKeyByGitRemote(remoteUrl)).toBeNull();
    });

    it('resolves SonarCloud project key via bindings then search_projects', async () => {
      const cloudClient = new ProjectBindingsClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ bindings: [{ projectId: 'proj:abc' }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({ components: [{ key: 'cloud-project-key', name: 'Cloud Project' }] }),
        } as Response);

      const key = await cloudClient.getProjectKeyByGitRemote(remoteUrl, 'my-org');
      expect(key).toBe('cloud-project-key');
      expect((fetchSpy.mock.calls[0][0] as URL).toString()).toBe(
        `${SONARCLOUD_API_URL}/dop-translation/project-bindings?url=${encodeURIComponent(remoteUrl)}`,
      );
      expect((fetchSpy.mock.calls[1][0] as URL).toString()).toContain(
        '/api/components/search_projects?',
      );
      expect((fetchSpy.mock.calls[1][0] as URL).toString()).toContain('organization=my-org');
      expect((fetchSpy.mock.calls[1][0] as URL).toString()).toContain('projectIds=proj%3Aabc');
    });

    it('returns null on SonarCloud when organization is missing', async () => {
      const cloudClient = new ProjectBindingsClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      fetchSpy = mockFetch({ bindings: [{ projectId: 'proj:abc' }] });
      expect(await cloudClient.getProjectKeyByGitRemote(remoteUrl)).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null when SonarCloud has multiple bindings', async () => {
      const cloudClient = new ProjectBindingsClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      fetchSpy = mockFetch({
        bindings: [{ projectId: 'proj:a' }, { projectId: 'proj:b' }],
      });
      expect(await cloudClient.getProjectKeyByGitRemote(remoteUrl, 'my-org')).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('strips embedded credentials from the remote before calling SonarCloud', async () => {
      const cloudClient = new ProjectBindingsClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      const remoteWithCredentials = 'https://user:token@github.com/foo/bar.git';
      const sanitizedRemote = 'https://github.com/foo/bar.git';
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ bindings: [{ projectId: 'proj:abc' }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({ components: [{ key: 'cloud-project-key', name: 'Cloud Project' }] }),
        } as Response);

      const key = await cloudClient.getProjectKeyByGitRemote(remoteWithCredentials, 'my-org');
      expect(key).toBe('cloud-project-key');
      expect((fetchSpy.mock.calls[0][0] as URL).toString()).toBe(
        `${SONARCLOUD_API_URL}/dop-translation/project-bindings?url=${encodeURIComponent(sanitizedRemote)}`,
      );
    });

    it('returns null when SonarCloud project-bindings request fails', async () => {
      const cloudClient = new ProjectBindingsClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      fetchSpy = mockFetch({ message: 'not found' }, { ok: false, status: 404 });
      expect(await cloudClient.getProjectKeyByGitRemote(remoteUrl, 'my-org')).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns null when SonarCloud search_projects request fails', async () => {
      const cloudClient = new ProjectBindingsClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ bindings: [{ projectId: 'proj:abc' }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          json: () => Promise.resolve({ message: 'Insufficient privileges' }),
        } as Response);

      expect(await cloudClient.getProjectKeyByGitRemote(remoteUrl, 'my-org')).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('returns null when SonarCloud search_projects omits components', async () => {
      const cloudClient = new ProjectBindingsClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ bindings: [{ projectId: 'proj:abc' }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({}),
        } as Response);

      expect(await cloudClient.getProjectKeyByGitRemote(remoteUrl, 'my-org')).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('listGitlabDopSettings', () => {
    it('returns only gitlab-type settings', async () => {
      fetchSpy = mockFetch({
        dopSettings: [
          { id: 'g1', key: 'my-gitlab', type: 'gitlab', url: 'https://gitlab.com' },
          { id: 'gh1', key: 'my-github', type: 'github', url: 'https://github.com' },
        ],
      });
      const result = await client.listGitlabDopSettings();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 'g1', key: 'my-gitlab', url: 'https://gitlab.com' });
    });

    it('returns empty array when no gitlab settings exist', async () => {
      fetchSpy = mockFetch({ dopSettings: [] });
      expect(await client.listGitlabDopSettings()).toEqual([]);
    });
  });

  describe('getAllProjectBindings', () => {
    it('returns a map of repository → projectKey for a single page', async () => {
      fetchSpy = mockFetch({
        projectBindings: [{ projectKey: 'my-project', repository: '123' }],
        page: { total: 1, pageSize: 500, pageIndex: 1 },
      });
      const result = await client.getAllProjectBindings('dop-id');
      expect(result.get('123')).toBe('my-project');
      expect(result.size).toBe(1);
    });

    it('paginates using the server-returned pageSize', async () => {
      // Server caps at 2 items per page even though we request 500
      const page1 = {
        projectBindings: [
          { projectKey: 'p1', repository: '1' },
          { projectKey: 'p2', repository: '2' },
        ],
        page: { total: 3, pageSize: 2, pageIndex: 1 },
      };
      const page2 = {
        projectBindings: [{ projectKey: 'p3', repository: '3' }],
        page: { total: 3, pageSize: 2, pageIndex: 2 },
      };
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(page1),
          text: () => Promise.resolve(''),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve(page2),
          text: () => Promise.resolve(''),
        } as Response);
      const result = await client.getAllProjectBindings('dop-id');
      expect(result.size).toBe(3);
      expect(result.get('3')).toBe('p3');
    });

    it('passes dopSettingId as a query parameter', async () => {
      fetchSpy = mockFetch({
        projectBindings: [],
        page: { total: 0, pageSize: 500, pageIndex: 1 },
      });
      await client.getAllProjectBindings('my-dop-id');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.searchParams.get('dopSettingId')).toBe('my-dop-id');
    });
  });
});

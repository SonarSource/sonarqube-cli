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

import { ComponentsClient } from '@/core/server/components.ts';
import { RateLimitError, ServiceUnavailableError } from '@/core/server/errors.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { lastFetchUrl, mockFetch } from '../../helpers/mock-fetch.ts';

const SERVER_URL = 'https://sonarqube.example.com';
const TOKEN = 'squ_test_token';

describe('ComponentsClient', () => {
  let client: ComponentsClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new ComponentsClient(new SonarHttpClient(SERVER_URL, TOKEN));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('getProjectSettings', () => {
    it('returns the settings array on success', async () => {
      const settings = [
        { key: 'sonar.exclusions', values: ['**/test/**'], inherited: false },
        { key: 'sonar.sca.foo', value: 'bar', inherited: false },
      ];
      fetchSpy = mockFetch({ settings });
      expect(await client.getProjectSettings('demo')).toEqual(settings);
    });

    it('returns an empty array when the API omits settings', async () => {
      fetchSpy = mockFetch({});
      expect(await client.getProjectSettings('demo')).toEqual([]);
    });

    it('passes the project key as the component query param', async () => {
      fetchSpy = mockFetch({ settings: [] });
      await client.getProjectSettings('demo');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/settings/values');
      expect(url.searchParams.get('component')).toBe('demo');
    });

    it('throws "Project ... not found" on 404', async () => {
      fetchSpy = mockFetch({ errors: [{ msg: 'Not found' }] }, { ok: false, status: 404 });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.getProjectSettings('missing')).rejects.toThrow(
        "Project 'missing' not found",
      );
    });

    it('throws a generic API error on other non-ok statuses', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 500 });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.getProjectSettings('demo')).rejects.toThrow('SonarQube API error: 500');
    });
  });

  describe('checkComponent', () => {
    it('returns true when component exists', async () => {
      fetchSpy = mockFetch({ component: { key: 'my-project' } });
      expect(await client.checkComponent('my-project')).toBe(true);
    });

    it('returns false when component is not found', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 404 });
      expect(await client.checkComponent('missing-project')).toBe(false);
    });

    it('passes the component key as a query parameter', async () => {
      fetchSpy = mockFetch({ component: {} });
      await client.checkComponent('my-project');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.searchParams.get('component')).toBe('my-project');
    });
  });

  describe('componentExists', () => {
    it('returns true when component exists', async () => {
      fetchSpy = mockFetch({ component: { key: 'my-project' } });
      expect(await client.componentExists('my-project')).toBe(true);
    });

    it('returns false when component is not found (404)', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 404 });
      expect(await client.componentExists('missing-project')).toBe(false);
    });

    it('propagates a rate-limit error instead of reporting the component as missing', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 429 });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.componentExists('my-project')).rejects.toThrow(RateLimitError);
    });

    it('propagates a service-unavailable error instead of reporting the component as missing', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 503 });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.componentExists('my-project')).rejects.toThrow(ServiceUnavailableError);
    });

    it('propagates a forbidden/auth failure instead of reporting the component as missing', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 403 });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.componentExists('my-project')).rejects.toThrow('Access denied');
    });
  });

  describe('checkQualityProfiles', () => {
    it('returns true when the request succeeds', async () => {
      fetchSpy = mockFetch({ profiles: [] });
      expect(await client.checkQualityProfiles('my-project')).toBe(true);
    });

    it('passes the project key as a query parameter', async () => {
      fetchSpy = mockFetch({ profiles: [] });
      await client.checkQualityProfiles('my-project');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.searchParams.get('project')).toBe('my-project');
    });

    it('passes the organization key when provided', async () => {
      fetchSpy = mockFetch({ profiles: [] });
      await client.checkQualityProfiles('my-project', 'my-org');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.searchParams.get('organization')).toBe('my-org');
    });

    it('omits the organization key when not provided', async () => {
      fetchSpy = mockFetch({ profiles: [] });
      await client.checkQualityProfiles('my-project');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.searchParams.get('organization')).toBeNull();
    });

    it('returns false on error', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 403 });
      expect(await client.checkQualityProfiles('my-project')).toBe(false);
    });
  });

  describe('getComponentId', () => {
    it('returns the component id when found', async () => {
      fetchSpy = mockFetch({ id: 'AYmy-projectlegacy', key: 'my-project' });
      expect(await client.getComponentId('my-project')).toBe('AYmy-projectlegacy');
    });

    it('returns null when component is not found', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 404 });
      expect(await client.getComponentId('missing-project')).toBeNull();
    });

    it('passes the component key as a query parameter to /api/navigation/component', async () => {
      fetchSpy = mockFetch({ id: 'AYlegacy' });
      await client.getComponentId('my-project');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/navigation/component');
      expect(url.searchParams.get('component')).toBe('my-project');
    });
  });

  describe('hasProjectBeenAnalyzed', () => {
    it('returns true when analyses array is non-empty', async () => {
      fetchSpy = mockFetch({ analyses: [{ key: 'abc' }] });
      expect(await client.hasProjectBeenAnalyzed('my-project')).toBe(true);
    });

    it('returns false when analyses array is empty', async () => {
      fetchSpy = mockFetch({ analyses: [] });
      expect(await client.hasProjectBeenAnalyzed('my-project')).toBe(false);
    });

    it('returns false on 404 (project has no analysis history)', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 404 });
      expect(await client.hasProjectBeenAnalyzed('my-project')).toBe(false);
    });

    it('throws on 403 so access errors are not silently treated as unanalyzed', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 403 });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.hasProjectBeenAnalyzed('my-project')).rejects.toThrow('403');
    });
  });
});

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

import { SonarHttpClient } from '@/core/server/http-client.ts';
import { ProjectsClient } from '@/core/server/projects.ts';

import { lastFetchInit, lastFetchUrl, mockFetch } from '../../helpers/mock-fetch.ts';

const SERVER_URL = 'https://sonarqube.example.com';

describe('ProjectsClient public project lookup', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('uses an authenticated public lookup and preserves the returned opaque id', async () => {
    const body = { projects: [{ id: 'opaque-project-id', key: 'shop:api' }], page: { total: 1 } };
    fetchSpy = mockFetch(body);
    const client = new ProjectsClient(new SonarHttpClient(SERVER_URL, 'test-token'));

    expect(await client.getProjectsByKey('shop:api').orThrow()).toEqual(body);
    const url = new URL(lastFetchUrl(fetchSpy));
    expect(url.origin).toBe(SERVER_URL);
    expect(url.pathname).toBe('/api/v2/components/projects');
    expect(Object.fromEntries(url.searchParams)).toEqual({ keys: 'shop:api', pageSize: '1' });
    expect(new Headers(lastFetchInit(fetchSpy).headers).get('Authorization')).toBe(
      'Bearer test-token',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns an empty public result without inventing a project id', async () => {
    const body = { projects: [], page: { total: 0 } };
    fetchSpy = mockFetch(body);
    const client = new ProjectsClient(new SonarHttpClient(SERVER_URL, 'test-token'));

    expect(await client.getProjectsByKey('missing').orThrow()).toEqual(body);
  });

  it.each([401, 403, 404])('propagates HTTP %s without trying another endpoint', async (status) => {
    fetchSpy = mockFetch({}, { status, ok: false });
    const client = new ProjectsClient(new SonarHttpClient(SERVER_URL, 'test-token'));
    const result = await client.getProjectsByKey('shop');

    expect(result.isErr()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new URL(lastFetchUrl(fetchSpy)).pathname).toBe('/api/v2/components/projects');
  });
});

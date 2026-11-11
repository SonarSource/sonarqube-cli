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

import { okAsync } from '@/core/result.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { ProjectsClient } from '@/core/server/projects.ts';
import type { ComponentShowResponse } from '@/core/server/types.ts';

import {
  fakeResponse,
  lastFetchInit,
  lastFetchUrl,
  mockFetch,
  mockFetchSeq,
  nthFetchUrl,
} from '../../helpers/mock-fetch.ts';

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

  it('returns undefined when the public lookup response has no body', async () => {
    fetchSpy = mockFetch(undefined, { status: 204 });
    const client = new ProjectsClient(new SonarHttpClient(SERVER_URL, 'test-token'));

    expect(await client.getProjectsByKey('missing').orThrow()).toBeUndefined();
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

function clientReturning(response: ComponentShowResponse | null): ProjectsClient {
  const http = { getOrNullIf404: () => okAsync(response) } as unknown as SonarHttpClient;
  return new ProjectsClient(http);
}

function show(component: Partial<ComponentShowResponse['component']>): ComponentShowResponse {
  return { component: { key: 'k', name: 'Name', qualifier: 'TRK', ...component } };
}

describe('ProjectsClient.findProject', () => {
  it('resolves a project with its name', async () => {
    const result = await clientReturning(show({})).findProject('k');

    expect(result.isOk() && result.value).toEqual({ key: 'k', name: 'Name' });
  });

  it('resolves null when the server has no such component', async () => {
    const result = await clientReturning(null).findProject('k');

    expect(result.isOk() && result.value).toBeNull();
  });

  it('resolves null for a component that is not a project', async () => {
    const result = await clientReturning(show({ qualifier: 'FIL' })).findProject('k');

    expect(result.isOk() && result.value).toBeNull();
  });

  it('resolves null for a project of another organization', async () => {
    const result = await clientReturning(show({ organization: 'other' })).findProject('k', 'mine');

    expect(result.isOk() && result.value).toBeNull();
  });

  it('accepts a project of the requested organization', async () => {
    const result = await clientReturning(show({ organization: 'mine' })).findProject('k', 'mine');

    expect(result.isOk() && result.value).toEqual({ key: 'k', name: 'Name' });
  });
});

describe('ProjectsClient.findProjectKeysByIds', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  const client = () => new ProjectsClient(new SonarHttpClient(SERVER_URL, 'test-token'));

  it('resolves the keys of the organization projects with these ids', async () => {
    fetchSpy = mockFetch({ components: [{ key: 'org_api' }, { key: 'org_web' }] });

    expect(await client().findProjectKeysByIds('org', ['id-1', 'id-2']).orThrow()).toEqual([
      'org_api',
      'org_web',
    ]);
    const url = new URL(lastFetchUrl(fetchSpy));
    expect(url.pathname).toBe('/api/components/search_projects');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      organization: 'org',
      projectIds: 'id-1,id-2',
      ps: '50',
    });
  });

  it('yields no key for an id outside the organization', async () => {
    fetchSpy = mockFetch({});

    expect(await client().findProjectKeysByIds('org', ['elsewhere']).orThrow()).toEqual([]);
  });

  it('splits more than 50 ids over several requests, in order', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `id-${index}`);
    fetchSpy = mockFetchSeq(
      fakeResponse({ components: [{ key: 'first' }] }),
      fakeResponse({ components: [{ key: 'second' }] }),
    );

    expect(await client().findProjectKeysByIds('org', ids).orThrow()).toEqual(['first', 'second']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(new URL(nthFetchUrl(fetchSpy, 1)).searchParams.get('projectIds')).toBe('id-50');
  });

  it('makes no request without ids', async () => {
    fetchSpy = mockFetch({});

    expect(await client().findProjectKeysByIds('org', []).orThrow()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

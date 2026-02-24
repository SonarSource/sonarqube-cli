/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import { SONARCLOUD_API_URL, SONARCLOUD_URL } from '../../src/lib/config-constants.js';
import { version as VERSION } from '../../package.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(body: unknown, ok = true, status = 200): ReturnType<typeof spyOn> {
  const statusText = ok ? 'OK' : 'Internal Server Error';
  return spyOn(globalThis, 'fetch').mockResolvedValue({
    ok,
    status,
    statusText,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function lastFetchUrl(fetchSpy: ReturnType<typeof spyOn>): string {
  return (fetchSpy.mock.calls[0][0] as URL).toString();
}

function lastFetchInit(fetchSpy: ReturnType<typeof spyOn>): RequestInit {
  return fetchSpy.mock.calls[0][1] as RequestInit;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SERVER_URL = 'https://sonarqube.example.com';
const TOKEN = 'squ_test_token';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SonarQubeClient', () => {
  let client: SonarQubeClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new SonarQubeClient(SERVER_URL, TOKEN);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  // -------------------------------------------------------------------------
  // get — shared request behaviour
  // -------------------------------------------------------------------------

  describe('get', () => {
    it('uses serverURL as base by default', async () => {
      fetchSpy = mockFetch({ valid: true });
      await client.get('/api/authentication/validate');
      expect(lastFetchUrl(fetchSpy)).toBe(`${SERVER_URL}/api/authentication/validate`);
    });

    it('strips trailing slash from serverURL', async () => {
      const clientWithSlash = new SonarQubeClient(`${SERVER_URL}/`, TOKEN);
      fetchSpy = mockFetch({ valid: true });
      await clientWithSlash.get('/api/authentication/validate');
      expect(lastFetchUrl(fetchSpy)).toBe(`${SERVER_URL}/api/authentication/validate`);
    });

    it('appends query parameters to the URL', async () => {
      fetchSpy = mockFetch({ organizations: [] });
      await client.get('/api/organizations/search', {
        organizations: 'my-org',
        ps: 1,
        active: true,
      });
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.searchParams.get('organizations')).toBe('my-org');
      expect(url.searchParams.get('ps')).toBe('1');
      expect(url.searchParams.get('active')).toBe('true');
    });

    it('sends Bearer authorization header', async () => {
      fetchSpy = mockFetch({});
      await client.get('/api/authentication/validate');
      expect(lastFetchInit(fetchSpy).headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
      });
    });

    it('sends User-Agent header with CLI version', async () => {
      fetchSpy = mockFetch({});
      await client.get('/api/authentication/validate');
      expect(lastFetchInit(fetchSpy).headers).toMatchObject({
        'User-Agent': `sonarqube-cli/${VERSION}`,
      });
    });

    it('uses the provided baseUrl instead of serverURL', async () => {
      fetchSpy = mockFetch({ id: 'org-uuid' });
      await client.get('/organizations', { organizationKey: 'my-org' }, SONARCLOUD_API_URL);
      expect(lastFetchUrl(fetchSpy)).toBe(
        `${SONARCLOUD_API_URL}/organizations?organizationKey=my-org`,
      );
    });

    it('throws when response is not ok', () => {
      fetchSpy = mockFetch({}, false, 401);
      expect(client.get('/api/authentication/validate')).rejects.toThrow(
        'SonarQube API error: 401',
      );
    });
  });

  // -------------------------------------------------------------------------
  // post — shared request behaviour
  // -------------------------------------------------------------------------

  describe('post', () => {
    it('sends POST with JSON body', async () => {
      fetchSpy = mockFetch({ result: 'ok' });
      await client.post('/api/some/endpoint', { key: 'value' });
      const init = lastFetchInit(fetchSpy);
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ key: 'value' }));
    });

    it('sets Content-Type: application/json', async () => {
      fetchSpy = mockFetch({});
      await client.post('/api/some/endpoint', {});
      expect(lastFetchInit(fetchSpy).headers).toMatchObject({
        'Content-Type': 'application/json',
      });
    });

    it('throws with error body text when response is not ok', () => {
      fetchSpy = mockFetch({ message: 'Not found' }, false, 404);
      expect(client.post('/api/some/endpoint', {})).rejects.toThrow('404');
    });
  });

  // -------------------------------------------------------------------------
  // validateToken
  // -------------------------------------------------------------------------

  describe('validateToken', () => {
    it('returns true when API reports the token as valid', async () => {
      fetchSpy = mockFetch({ valid: true });
      expect(await client.validateToken()).toBe(true);
    });

    it('returns false when API reports the token as invalid', async () => {
      fetchSpy = mockFetch({ valid: false });
      expect(await client.validateToken()).toBe(false);
    });

    it('returns false on network / API error', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
      expect(await client.validateToken()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getSystemStatus
  // -------------------------------------------------------------------------

  describe('getSystemStatus', () => {
    it('returns status, version and id from the API', async () => {
      const payload = { status: 'UP', version: '10.4.0', id: 'inst-uuid' };
      fetchSpy = mockFetch(payload);
      const result = await client.getSystemStatus();
      expect(result).toEqual(payload);
    });

    it('calls the correct endpoint', async () => {
      fetchSpy = mockFetch({ status: 'UP', version: '10.4.0' });
      await client.getSystemStatus();
      expect(lastFetchUrl(fetchSpy)).toBe(`${SERVER_URL}/api/system/status`);
    });
  });

  // -------------------------------------------------------------------------
  // getCurrentUser
  // -------------------------------------------------------------------------

  describe('getCurrentUser', () => {
    it('returns the user object on success', async () => {
      fetchSpy = mockFetch({ id: 'user-uuid-123' });
      const user = await client.getCurrentUser();
      expect(user).toEqual({ id: 'user-uuid-123' });
    });

    it('returns null on error', async () => {
      fetchSpy = mockFetch({}, false, 401);
      expect(await client.getCurrentUser()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getOrganizationId
  // -------------------------------------------------------------------------

  describe('getOrganizationId', () => {
    it('hits api.sonarcloud.io, not the serverURL', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch({ id: 'org-uuid-v4' });
      await cloudClient.getOrganizationId('my-org');
      expect(lastFetchUrl(fetchSpy)).toContain(SONARCLOUD_API_URL);
      expect(lastFetchUrl(fetchSpy)).not.toContain(`${SONARCLOUD_URL}/api`);
    });

    it('calls /organizations with organizationKey param', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch({ id: 'org-uuid-v4' });
      await cloudClient.getOrganizationId('my-org');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/organizations');
      expect(url.searchParams.get('organizationKey')).toBe('my-org');
    });

    it('returns the organization id on success', async () => {
      fetchSpy = mockFetch({ id: 'org-uuid-v4' });
      expect(await client.getOrganizationId('my-org')).toBe('org-uuid-v4');
    });

    it('returns null on error', async () => {
      fetchSpy = mockFetch({}, false, 404);
      expect(await client.getOrganizationId('unknown-org')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // checkComponent
  // -------------------------------------------------------------------------

  describe('checkComponent', () => {
    it('returns true when component exists', async () => {
      fetchSpy = mockFetch({ component: { key: 'my-project' } });
      expect(await client.checkComponent('my-project')).toBe(true);
    });

    it('returns false when component is not found', async () => {
      fetchSpy = mockFetch({}, false, 404);
      expect(await client.checkComponent('missing-project')).toBe(false);
    });

    it('passes the component key as a query parameter', async () => {
      fetchSpy = mockFetch({ component: {} });
      await client.checkComponent('my-project');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.searchParams.get('component')).toBe('my-project');
    });
  });

  // -------------------------------------------------------------------------
  // getOrganizations
  // -------------------------------------------------------------------------

  describe('getOrganizations', () => {
    it('returns the organizations list on success', async () => {
      const orgs = [
        { key: 'org-a', name: 'Org A' },
        { key: 'org-b', name: 'Org B' },
      ];
      fetchSpy = mockFetch({ organizations: orgs });
      expect(await client.getOrganizations()).toEqual(orgs);
    });

    it('returns an empty array when the organizations field is missing', async () => {
      fetchSpy = mockFetch({});
      expect(await client.getOrganizations()).toEqual([]);
    });

    it('returns an empty array on error', async () => {
      fetchSpy = mockFetch({}, false, 500);
      expect(await client.getOrganizations()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // checkOrganization
  // -------------------------------------------------------------------------

  describe('checkOrganization', () => {
    it('returns true when the organization is in the results', async () => {
      fetchSpy = mockFetch({ organizations: [{ key: 'my-org' }] });
      expect(await client.checkOrganization('my-org')).toBe(true);
    });

    it('returns false when the organization is not in the results', async () => {
      fetchSpy = mockFetch({ organizations: [{ key: 'other-org' }] });
      expect(await client.checkOrganization('my-org')).toBe(false);
    });

    it('returns false on error', async () => {
      fetchSpy = mockFetch({}, false, 500);
      expect(await client.checkOrganization('my-org')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // checkQualityProfiles
  // -------------------------------------------------------------------------

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
      fetchSpy = mockFetch({}, false, 403);
      expect(await client.checkQualityProfiles('my-project')).toBe(false);
    });
  });
});

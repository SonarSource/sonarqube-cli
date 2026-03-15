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
import {
  SONARCLOUD_API_URL,
  SONARCLOUD_URL,
  SONARCLOUD_US_URL,
} from '../../src/lib/config-constants.js';
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
      fetchSpy = mockFetch([{ id: 'str-id', uuidV4: 'org-uuid-v4' }]);
      await cloudClient.getOrganizationId('my-org');
      expect(lastFetchUrl(fetchSpy)).toContain(SONARCLOUD_API_URL);
      expect(lastFetchUrl(fetchSpy)).not.toContain(`${SONARCLOUD_URL}/api`);
    });

    it('calls /organizations/organizations with organizationKey param', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch([{ id: 'str-id', uuidV4: 'org-uuid-v4' }]);
      await cloudClient.getOrganizationId('my-org');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/organizations/organizations');
      expect(url.searchParams.get('organizationKey')).toBe('my-org');
    });

    it('returns the uuidV4 of the first result on success', async () => {
      fetchSpy = mockFetch([{ id: 'str-id', uuidV4: 'org-uuid-v4' }]);
      expect(await client.getOrganizationId('my-org')).toBe('org-uuid-v4');
    });

    it('returns null on error', async () => {
      fetchSpy = mockFetch({}, false, 404);
      expect(await client.getOrganizationId('unknown-org')).toBeNull();
    });

    it('returns null when result array is empty', async () => {
      fetchSpy = mockFetch([]);
      expect(await client.getOrganizationId('my-org')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // hasA3sEntitlement
  // -------------------------------------------------------------------------

  describe('hasA3sEntitlement', () => {
    let cloudClient: SonarQubeClient;

    beforeEach(() => {
      cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
    });

    it('returns false when organizationKey is not provided', async () => {
      fetchSpy = mockFetch({});
      expect(await cloudClient.hasA3sEntitlement(undefined)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns false when organizationKey is empty string', async () => {
      fetchSpy = mockFetch({});
      expect(await cloudClient.hasA3sEntitlement('')).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns false when server is not SonarQube Cloud', async () => {
      const serverClient = new SonarQubeClient(SERVER_URL, TOKEN);
      fetchSpy = mockFetch({});
      expect(await serverClient.hasA3sEntitlement('my-org')).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns false when org UUID cannot be resolved (API error)', async () => {
      fetchSpy = mockFetch({}, false, 404);
      expect(await cloudClient.hasA3sEntitlement('unknown-org')).toBe(false);
    });

    it('returns false when org UUID list is empty', async () => {
      fetchSpy = mockFetch([]);
      expect(await cloudClient.hasA3sEntitlement('my-org')).toBe(false);
    });

    it('returns true when org UUID is resolved and entitlement is enabled and eligible', async () => {
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ id: 'str-id', uuidV4: 'org-uuid' }]),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 'org-uuid', enabled: true, eligible: true }),
        } as Response);

      expect(await cloudClient.hasA3sEntitlement('my-org')).toBe(true);
    });

    it('returns false when entitlement is enabled but not eligible', async () => {
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ id: 'str-id', uuidV4: 'org-uuid' }]),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 'org-uuid', enabled: true, eligible: false }),
        } as Response);

      expect(await cloudClient.hasA3sEntitlement('my-org')).toBe(false);
    });

    it('returns false when entitlement is eligible but not enabled', async () => {
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ id: 'str-id', uuidV4: 'org-uuid' }]),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 'org-uuid', enabled: false, eligible: true }),
        } as Response);

      expect(await cloudClient.hasA3sEntitlement('my-org')).toBe(false);
    });

    it('returns false when the entitlement check fails with an API error', async () => {
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ id: 'str-id', uuidV4: 'org-uuid' }]),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          json: () => Promise.resolve({}),
        } as Response);

      expect(await cloudClient.hasA3sEntitlement('my-org')).toBe(false);
    });

    it('passes the resolved UUID to the entitlement check', async () => {
      const targetUuid = 'specific-uuid-abc';
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ id: 'str-id', uuidV4: targetUuid }]),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: targetUuid, enabled: true, eligible: true }),
        } as Response);

      await cloudClient.hasA3sEntitlement('my-org');

      const entitlementUrl = new URL((fetchSpy.mock.calls[1][0] as URL).toString());
      expect(entitlementUrl.pathname).toBe(`/a3s-analysis/org-config/${targetUuid}`);
    });

    it('returns true for SonarQube Cloud US', async () => {
      const usClient = new SonarQubeClient(SONARCLOUD_US_URL, TOKEN);
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve([{ id: 'str-id', uuidV4: 'org-uuid' }]),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 'org-uuid', enabled: true, eligible: true }),
        } as Response);

      expect(await usClient.hasA3sEntitlement('my-org')).toBe(true);
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

  // -------------------------------------------------------------------------
  // analyzeFile
  // -------------------------------------------------------------------------

  describe('analyzeFile', () => {
    it('sends POST to SONARCLOUD_API_URL/a3s-analysis/analyses', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.analyzeFile({
        organizationKey: 'my-org',
        projectKey: 'my-project',
        filePath: 'src/index.ts',
        fileContent: 'const x = 1;',
      });

      const url = lastFetchUrl(fetchSpy);
      expect(url).toBe(`${SONARCLOUD_API_URL}/a3s-analysis/analyses`);
    });

    it('sends Bearer token in Authorization header', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.analyzeFile({
        organizationKey: 'my-org',
        projectKey: 'my-project',
        filePath: 'src/index.ts',
        fileContent: 'const x = 1;',
      });

      const init = lastFetchInit(fetchSpy);
      expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    });

    it('sends request body as JSON', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.analyzeFile({
        organizationKey: 'my-org',
        projectKey: 'my-project',
        filePath: 'src/index.ts',
        fileContent: 'const x = 1;',
      });

      const init = lastFetchInit(fetchSpy);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.organizationKey).toBe('my-org');
      expect(body.projectKey).toBe('my-project');
      expect(body.filePath).toBe('src/index.ts');
      expect(body.fileContent).toBe('const x = 1;');
    });

    it('does not include branchName in body when not provided', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.analyzeFile({
        organizationKey: 'my-org',
        projectKey: 'my-project',
        filePath: 'src/index.ts',
        fileContent: 'const x = 1;',
      });

      const init = lastFetchInit(fetchSpy);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.branchName).toBeUndefined();
    });

    it('includes branchName in body when provided', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.analyzeFile({
        organizationKey: 'my-org',
        projectKey: 'my-project',
        filePath: 'src/index.ts',
        fileContent: 'const x = 1;',
        branchName: 'feature/my-branch',
      });

      const init = lastFetchInit(fetchSpy);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.branchName).toBe('feature/my-branch');
    });

    it('returns parsed response', async () => {
      const mockResponse = {
        id: 'analysis-123',
        issues: [{ rule: 'ts:S1234', message: 'Fix this', textRange: null }],
        errors: null,
      };
      fetchSpy = mockFetch(mockResponse);

      const result = await client.analyzeFile({
        organizationKey: 'my-org',
        projectKey: 'my-project',
        filePath: 'src/index.ts',
        fileContent: 'const x = 1;',
      });

      expect(result.id).toBe('analysis-123');
      expect(result.issues).toHaveLength(1);
    });

    it('throws on non-OK response', () => {
      fetchSpy = mockFetch({ message: 'Invalid request body' }, false, 400);

      expect(
        client.analyzeFile({
          organizationKey: 'my-org',
          projectKey: 'my-project',
          filePath: 'src/index.ts',
          fileContent: 'const x = 1;',
        }),
      ).rejects.toThrow('400');
    });
  });
});

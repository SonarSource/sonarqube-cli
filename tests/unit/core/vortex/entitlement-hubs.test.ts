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
  SONARCLOUD_URL,
  SONARCLOUD_US_API_URL,
  SONARCLOUD_US_URL,
} from '@/core/config-constants.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import {
  checkHubEntitlement,
  SERVER_ORGANIZATION_ID_PLACEHOLDER,
  VortexEntitlementClient,
} from '@/core/vortex/entitlement.ts';

import { lastFetchUrl, mockFetch } from '../../helpers/mock-fetch.ts';

function fetchPathnames(fetchSpy: ReturnType<typeof spyOn>): string[] {
  const paths: string[] = [];
  for (let index = 0; index < fetchSpy.mock.calls.length; index += 1) {
    paths.push(new URL(fetchSpy.mock.calls[index][0] as URL).pathname);
  }
  return paths;
}

const SERVER_URL = 'https://sonarqube.example.com';
const TOKEN = 'squ_test_token';

describe('VortexEntitlementClient', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('checkHubEntitlement', () => {
    const UUID = 'org-uuid';
    const CLOUD_CAG = `/cag/cag-entitlement/${UUID}`;
    const CLOUD_SQAA = `/a3s-analysis/org-entitlement/${UUID}`;
    const SERVER_CAG = `/api/v2/cag/cag-entitlement/${UUID}`;
    const SERVER_SQAA = `/api/v2/a3s/org-entitlement/${UUID}`;
    let cloudHttp: SonarHttpClient;
    let serverHttp: SonarHttpClient;

    beforeEach(() => {
      cloudHttp = new SonarHttpClient(SONARCLOUD_URL, TOKEN);
      serverHttp = new SonarHttpClient(SERVER_URL, TOKEN);
    });

    it("returns 'enabled' when the org is currently allowed", async () => {
      fetchSpy = mockFetch({ allowed: true, hasEntitlement: true });
      expect((await checkHubEntitlement(cloudHttp, CLOUD_CAG)).status).toBe('enabled');
    });

    it("returns 'over_consumption' when entitled but over its usage limit", async () => {
      fetchSpy = mockFetch({ allowed: false, hasEntitlement: true });
      expect((await checkHubEntitlement(cloudHttp, CLOUD_CAG)).status).toBe('over_consumption');
    });

    it("returns 'not_entitled' when hasEntitlement is false", async () => {
      fetchSpy = mockFetch({ allowed: false, hasEntitlement: false });
      expect((await checkHubEntitlement(cloudHttp, CLOUD_CAG)).status).toBe('not_entitled');
    });

    it("returns 'not_entitled' when hasEntitlement is absent", async () => {
      fetchSpy = mockFetch({});
      expect((await checkHubEntitlement(cloudHttp, CLOUD_CAG)).status).toBe('not_entitled');
    });

    it("returns 'check_failed' when the entitlement API errors out", async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 500 });
      expect((await checkHubEntitlement(cloudHttp, CLOUD_CAG)).status).toBe('check_failed');
    });

    it("returns 'check_failed' when a Cloud hub is missing (HTTP 404)", async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 404 });
      expect((await checkHubEntitlement(cloudHttp, CLOUD_SQAA)).status).toBe('check_failed');
    });

    it("returns 'not_applicable' when a Server hub is absent (HTTP 404)", async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 404 });
      expect((await checkHubEntitlement(serverHttp, SERVER_SQAA)).status).toBe('not_applicable');
    });

    it("returns 'check_failed' when the hub is unavailable (HTTP 503)", async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 503 });
      expect((await checkHubEntitlement(cloudHttp, CLOUD_CAG)).status).toBe('check_failed');
    });

    it('GETs the Cloud SQAA entitlement path', async () => {
      fetchSpy = mockFetch({ allowed: true, hasEntitlement: true });
      await checkHubEntitlement(cloudHttp, CLOUD_SQAA);
      expect(new URL(lastFetchUrl(fetchSpy)).pathname).toBe(CLOUD_SQAA);
    });

    it('GETs the Cloud CAG entitlement path', async () => {
      fetchSpy = mockFetch({ allowed: true, hasEntitlement: true });
      await checkHubEntitlement(cloudHttp, CLOUD_CAG);
      expect(new URL(lastFetchUrl(fetchSpy)).pathname).toBe(CLOUD_CAG);
    });

    it('GETs the Server SQAA entitlement path', async () => {
      fetchSpy = mockFetch({ allowed: true, hasEntitlement: true });
      await checkHubEntitlement(serverHttp, SERVER_SQAA);
      expect(new URL(lastFetchUrl(fetchSpy)).pathname).toBe(SERVER_SQAA);
    });

    it('GETs the Server CAG entitlement path', async () => {
      fetchSpy = mockFetch({ allowed: true, hasEntitlement: true });
      await checkHubEntitlement(serverHttp, SERVER_CAG);
      expect(new URL(lastFetchUrl(fetchSpy)).pathname).toBe(SERVER_CAG);
    });

    it('routes to the US API host for SonarQube Cloud US', async () => {
      const usHttp = new SonarHttpClient(SONARCLOUD_US_URL, TOKEN);
      fetchSpy = mockFetch({ allowed: true, hasEntitlement: true });
      expect((await checkHubEntitlement(usHttp, CLOUD_SQAA)).status).toBe('enabled');
      expect(lastFetchUrl(fetchSpy)).toContain(SONARCLOUD_US_API_URL);
    });

    it('forwards the consumption payload when present', async () => {
      fetchSpy = mockFetch({
        allowed: true,
        hasEntitlement: true,
        consumption: { consumed: 15860, limit: 1000000 },
      });
      const result = await checkHubEntitlement(cloudHttp, CLOUD_CAG);
      expect(result.consumption).toEqual({ consumed: 15860, limit: 1000000 });
    });

    it('omits consumption when the response does not include it', async () => {
      fetchSpy = mockFetch({ allowed: true, hasEntitlement: true });
      const result = await checkHubEntitlement(cloudHttp, CLOUD_CAG);
      expect(result.consumption).toBeUndefined();
    });
  });

  describe('hasVortexEntitlement', () => {
    let cloudClient: VortexEntitlementClient;

    beforeEach(() => {
      cloudClient = new VortexEntitlementClient(SONARCLOUD_URL, TOKEN);
    });

    it('returns not_entitled when organizationKey is not provided', async () => {
      fetchSpy = mockFetch({});
      expect((await cloudClient.hasVortexEntitlement(undefined)).status).toBe('not_entitled');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns not_entitled when organizationKey is empty string', async () => {
      fetchSpy = mockFetch({});
      expect((await cloudClient.hasVortexEntitlement('')).status).toBe('not_entitled');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('queries SQAA and CAG on SonarQube Server, using the placeholder org id', async () => {
      expect(SERVER_ORGANIZATION_ID_PLACEHOLDER).toBe('00000000-0000-0000-0000-000000000000');
      const serverClient = new VortexEntitlementClient(SERVER_URL, TOKEN);
      fetchSpy = mockFetch({ allowed: true, hasEntitlement: true });
      expect((await serverClient.hasVortexEntitlement()).status).toBe('enabled');
      expect(fetchPathnames(fetchSpy)).toEqual([
        `/api/v2/a3s/org-entitlement/${SERVER_ORGANIZATION_ID_PLACEHOLDER}`,
        `/api/v2/cag/cag-entitlement/${SERVER_ORGANIZATION_ID_PLACEHOLDER}`,
      ]);
    });

    it("returns 'not_applicable' when both Server hubs are absent", async () => {
      const serverClient = new VortexEntitlementClient(SERVER_URL, TOKEN);
      fetchSpy = mockFetch({}, { ok: false, status: 404 });
      expect((await serverClient.hasVortexEntitlement()).status).toBe('not_applicable');
    });

    it.each(['/a3s/', '/cag/'] as const)(
      "returns 'not_applicable' when the Server %s hub is absent even if the other is entitled",
      async (missingPath) => {
        const serverClient = new VortexEntitlementClient(SERVER_URL, TOKEN);
        fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((url: string | URL) => {
          const pathname = new URL(url).pathname;
          const missing = pathname.includes(missingPath);
          const body = missing ? {} : { allowed: true, hasEntitlement: true };
          return Promise.resolve({
            ok: !missing,
            status: missing ? 404 : 200,
            statusText: missing ? 'Not Found' : 'OK',
            json: () => Promise.resolve(body),
            text: () => Promise.resolve(JSON.stringify(body)),
          } as Response);
        }) as typeof fetch);

        expect((await serverClient.hasVortexEntitlement()).status).toBe('not_applicable');
      },
    );

    it("returns 'check_failed' when the Server Hub is unavailable", async () => {
      const serverClient = new VortexEntitlementClient(SERVER_URL, TOKEN);
      fetchSpy = mockFetch({}, { ok: false, status: 503 });
      expect((await serverClient.hasVortexEntitlement()).status).toBe('check_failed');
    });

    it('returns check_failed when org UUID cannot be resolved', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 404 });
      expect((await cloudClient.hasVortexEntitlement('unknown-org')).status).toBe('check_failed');
    });

    it('returns check_failed when org UUID list is empty', async () => {
      fetchSpy = mockFetch([]);
      expect((await cloudClient.hasVortexEntitlement('my-org')).status).toBe('check_failed');
    });

    it('forwards CAG consumption when the combined status is enabled', async () => {
      const uuid = 'org-uuid';
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((url: string | URL) => {
        const pathname = new URL(url).pathname;
        const body =
          pathname === '/organizations/organizations'
            ? [{ id: 'str-id', uuidV4: uuid }]
            : pathname === `/a3s-analysis/org-entitlement/${uuid}`
              ? { id: uuid, allowed: true, hasEntitlement: true }
              : {
                  allowed: true,
                  hasEntitlement: true,
                  consumption: { consumed: 15860, limit: 1000000 },
                };
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(JSON.stringify(body)),
        } as Response);
      }) as typeof fetch);

      const result = await cloudClient.hasVortexEntitlement('my-org');

      expect(result).toEqual({
        status: 'enabled',
        consumption: { consumed: 15860, limit: 1000000 },
      });
    });

    it('drops consumption when the combined status is over_consumption, even if CAG reports it', async () => {
      const uuid = 'org-uuid';
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((url: string | URL) => {
        const pathname = new URL(url).pathname;
        const body =
          pathname === '/organizations/organizations'
            ? [{ id: 'str-id', uuidV4: uuid }]
            : pathname === `/a3s-analysis/org-entitlement/${uuid}`
              ? { id: uuid, allowed: true, hasEntitlement: true }
              : {
                  allowed: false,
                  hasEntitlement: true,
                  consumption: { consumed: 1000000, limit: 1000000 },
                };
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(JSON.stringify(body)),
        } as Response);
      }) as typeof fetch);

      const result = await cloudClient.hasVortexEntitlement('my-org');

      expect(result).toEqual({
        status: 'over_consumption',
      });
    });
  });
});

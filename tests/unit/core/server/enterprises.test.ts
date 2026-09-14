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
import { EnterprisesClient } from '@/core/server/enterprises.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { fakeResponse, lastFetchUrl, mockFetch } from '../../helpers/mock-fetch.ts';

const TOKEN = 'squ_test_token';

describe('EnterprisesClient', () => {
  let client: EnterprisesClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new EnterprisesClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('getEnterpriseIdForOrganization', () => {
    it('hits the region-specific Cloud API host, not the serverURL', async () => {
      fetchSpy = mockFetch([{ enterpriseId: 'ent-uuid' }]);
      await client.getEnterpriseIdForOrganization('org-legacy-id').orThrow();
      expect(lastFetchUrl(fetchSpy)).toContain(SONARCLOUD_API_URL);
      expect(lastFetchUrl(fetchSpy)).not.toContain(`${SONARCLOUD_URL}/api`);
    });

    it('calls /enterprises/enterprise-organizations with organizationId param', async () => {
      fetchSpy = mockFetch([{ enterpriseId: 'ent-uuid' }]);
      await client.getEnterpriseIdForOrganization('org-legacy-id').orThrow();
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/enterprises/enterprise-organizations');
      expect(url.searchParams.get('organizationId')).toBe('org-legacy-id');
    });

    it('returns the enterpriseId of the first result on success', async () => {
      fetchSpy = mockFetch([{ enterpriseId: 'ent-uuid' }]);
      expect(await client.getEnterpriseIdForOrganization('org-legacy-id').orThrow()).toBe(
        'ent-uuid',
      );
    });

    it('returns null when the organization is in no enterprise (empty list)', async () => {
      fetchSpy = mockFetch([]);
      expect(await client.getEnterpriseIdForOrganization('org-legacy-id').orThrow()).toBeNull();
    });

    it('throws on a non-critical failure (e.g. 403) instead of caching it as absent', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        fakeResponse('Access denied', { ok: false, status: 403 }),
      );
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        client.getEnterpriseIdForOrganization('org-legacy-id').orThrow(),
      ).rejects.toThrow();
    });

    it('throws on a critical failure (e.g. 500)', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        fakeResponse('boom', { ok: false, status: 500 }),
      );
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        client.getEnterpriseIdForOrganization('org-legacy-id').orThrow(),
      ).rejects.toThrow();
    });
  });
});

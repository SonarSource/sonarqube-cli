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
  SONARCLOUD_API_URL,
  SONARCLOUD_URL,
  SONARCLOUD_US_API_URL,
  SONARCLOUD_US_URL,
} from '@/core/config-constants.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { OrganizationsClient } from '@/core/server/organizations.ts';

import { lastFetchUrl, mockFetch } from '../../helpers/mock-fetch.ts';

const SERVER_URL = 'https://sonarqube.example.com';
const TOKEN = 'squ_test_token';

describe('OrganizationsClient', () => {
  let client: OrganizationsClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new OrganizationsClient(new SonarHttpClient(SERVER_URL, TOKEN));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('getOrganizationId', () => {
    it('hits api.sonarcloud.io, not the serverURL', async () => {
      const cloudClient = new OrganizationsClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      fetchSpy = mockFetch([{ id: 'str-id', uuidV4: 'org-uuid-v4' }]);
      await cloudClient.getOrganizationId('my-org');
      expect(lastFetchUrl(fetchSpy)).toContain(SONARCLOUD_API_URL);
      expect(lastFetchUrl(fetchSpy)).not.toContain(`${SONARCLOUD_URL}/api`);
    });

    it('calls /organizations/organizations with organizationKey param', async () => {
      const cloudClient = new OrganizationsClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      fetchSpy = mockFetch([{ id: 'str-id', uuidV4: 'org-uuid-v4' }]);
      await cloudClient.getOrganizationId('my-org');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/organizations/organizations');
      expect(url.searchParams.get('organizationKey')).toBe('my-org');
    });

    it('hits api.sonarqube.us for US Cloud', async () => {
      const usClient = new OrganizationsClient(new SonarHttpClient(SONARCLOUD_US_URL, TOKEN));
      fetchSpy = mockFetch([{ id: 'str-id', uuidV4: 'org-uuid-v4' }]);
      await usClient.getOrganizationId('my-org');
      expect(lastFetchUrl(fetchSpy)).toContain(SONARCLOUD_US_API_URL);
    });

    it('returns the uuidV4 of the first result on success', async () => {
      fetchSpy = mockFetch([{ id: 'str-id', uuidV4: 'org-uuid-v4' }]);
      expect(await client.getOrganizationId('my-org')).toBe('org-uuid-v4');
    });

    it('returns null on error', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 404 });
      expect(await client.getOrganizationId('unknown-org')).toBeNull();
    });

    it('returns null when result array is empty', async () => {
      fetchSpy = mockFetch([]);
      expect(await client.getOrganizationId('my-org')).toBeNull();
    });
  });

  describe('isOrganizationAccessible', () => {
    it('returns true when the organization is in the results', async () => {
      fetchSpy = mockFetch({ organizations: [{ key: 'my-org' }] });
      expect(await client.isOrganizationAccessible('my-org')).toBe(true);
    });

    it('returns false when the organization is not in the results', async () => {
      fetchSpy = mockFetch({ organizations: [{ key: 'other-org' }] });
      expect(await client.isOrganizationAccessible('my-org')).toBe(false);
    });

    it('returns false on error', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 500 });
      expect(await client.isOrganizationAccessible('my-org')).toBe(false);
    });
  });

  describe('resolveOrganizationAccess', () => {
    it('reports an organization the server resolves as accessible', async () => {
      fetchSpy = mockFetch({ organizations: [{ key: 'my-org', name: 'My Org' }] });

      expect(await client.resolveOrganizationAccess('my-org')).toEqual({ status: 'accessible' });
    });

    it('reports an empty result as not_found', async () => {
      fetchSpy = mockFetch({ organizations: [] });

      expect(await client.resolveOrganizationAccess('my-org')).toEqual({ status: 'not_found' });
    });

    it('reports a server error as check_failed rather than as a missing organization', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 500 });

      const access = await client.resolveOrganizationAccess('my-org');

      expect(access.status).toBe('check_failed');
    });
  });
});

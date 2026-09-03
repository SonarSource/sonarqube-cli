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

import { SonarHttpClient } from '@/core/server/http-client.ts';
import { UsersClient } from '@/core/server/users.ts';

import { lastFetchInit, lastFetchUrl, mockFetch } from '../../helpers/mock-fetch.ts';

const SERVER_URL = 'https://sonarqube.example.com';
const TOKEN = 'squ_test_token';

describe('UsersClient', () => {
  let client: UsersClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new UsersClient(new SonarHttpClient(SERVER_URL, TOKEN));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('revokeUserToken', () => {
    it('POSTs name=<tokenName> to /api/user_tokens/revoke', async () => {
      fetchSpy = mockFetch({}, { status: 204 });
      await client.revokeUserToken('cli-token-name');
      expect(lastFetchUrl(fetchSpy)).toBe(`${SERVER_URL}/api/user_tokens/revoke`);
      const init = lastFetchInit(fetchSpy);
      expect(init.method).toBe('POST');
      expect(init.body).toBe('name=cli-token-name');
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${TOKEN}`,
      });
    });

    it('URL-encodes special characters in the token name', async () => {
      fetchSpy = mockFetch({}, { status: 204 });
      await client.revokeUserToken('cli token+with/special&chars');
      expect(lastFetchInit(fetchSpy).body).toBe('name=cli+token%2Bwith%2Fspecial%26chars');
    });

    it('propagates server errors to the caller', async () => {
      fetchSpy = mockFetch('revocation boom', { ok: false, status: 500 });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.revokeUserToken('cli-token-name')).rejects.toThrow(
        'SonarQube API error: 500 Internal Server Error',
      );
    });
  });

  describe('checkTokenValidity', () => {
    it("returns 'valid' when API reports the token as valid", async () => {
      fetchSpy = mockFetch({ valid: true });
      expect(await client.checkTokenValidity()).toBe('valid');
    });

    it("returns 'invalid' when API reports the token as invalid", async () => {
      fetchSpy = mockFetch({ valid: false });
      expect(await client.checkTokenValidity()).toBe('invalid');
    });

    it('throws on network / API error', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
      await expect(client.checkTokenValidity()).rejects.toThrow('Network error');
    });
  });

  describe('hasProvisionProjectsPermission', () => {
    it('returns true when provisioning is in global permissions', async () => {
      fetchSpy = mockFetch({ permissions: { global: ['provisioning', 'scan'] } });
      expect(await client.hasProvisionProjectsPermission()).toBe(true);
    });

    it('returns false when provisioning is absent', async () => {
      fetchSpy = mockFetch({ permissions: { global: ['scan'] } });
      expect(await client.hasProvisionProjectsPermission()).toBe(false);
    });

    it('returns false when permissions field is absent', async () => {
      fetchSpy = mockFetch({});
      expect(await client.hasProvisionProjectsPermission()).toBe(false);
    });
  });
});

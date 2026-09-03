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

import { SONARCLOUD_URL } from '@/core/config-constants.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { SystemClient } from '@/core/server/system.ts';

import { mockFetch } from '../../helpers/mock-fetch.ts';

const SERVER_URL = 'https://sonarqube.example.com';
const TOKEN = 'squ_test_token';

describe('SystemClient', () => {
  let client: SystemClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new SystemClient(new SonarHttpClient(SERVER_URL, TOKEN));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('getServerMode', () => {
    it('returns mqr immediately for SonarQube Cloud without calling the API', async () => {
      const cloudClient = new SystemClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
      fetchSpy = spyOn(globalThis, 'fetch');
      expect(await cloudClient.getServerMode()).toBe('mqr');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns mqr when server responds with MQR mode', async () => {
      fetchSpy = mockFetch({ mode: 'MQR' });
      expect(await client.getServerMode()).toBe('mqr');
    });

    it('returns standard when server responds with STANDARD mode', async () => {
      fetchSpy = mockFetch({ mode: 'STANDARD' });
      expect(await client.getServerMode()).toBe('standard');
    });

    it('returns standard when endpoint returns 404 (old server without MQR support)', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('Not Found'),
      } as Response);
      expect(await client.getServerMode()).toBe('standard');
    });

    it('throws when endpoint returns a server error', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      } as Response);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.getServerMode()).rejects.toThrow();
    });
  });
});

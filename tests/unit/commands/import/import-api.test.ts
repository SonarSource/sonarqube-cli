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

import { ImportApiClient } from '@/commands/import/import-api.ts';
import { SONARCLOUD_URL } from '@/core/config-constants.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { mockFetch } from '../../helpers/mock-fetch.ts';

describe('ImportApiClient.importRepository', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  function client(): ImportApiClient {
    return new ImportApiClient(new SonarHttpClient(SONARCLOUD_URL, 'token'));
  }

  it('resolves to the key of the provisioned project', async () => {
    fetchSpy = mockFetch({ projects: [{ projectKey: 'org_repository' }] });

    expect(await client().importRepository('org', 'install-key')).toBe('org_repository');
  });

  it('rejects when the server provisioned no project', async () => {
    fetchSpy = mockFetch({ projects: [] });

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(client().importRepository('org', 'install-key')).rejects.toThrow(
      'provision_projects returned no project',
    );
  });
});

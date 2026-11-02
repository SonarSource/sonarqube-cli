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

import { describe, expect, it } from 'bun:test';

import { okAsync } from '@/core/result.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { ProjectsClient } from '@/core/server/projects.ts';
import type { ComponentShowResponse } from '@/core/server/types.ts';

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

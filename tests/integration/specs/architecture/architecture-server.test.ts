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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { IntendedArchitecture } from '@/commands/architecture/_common/architecture-api.ts';
import { SonarArchitectureApi } from '@/commands/architecture/_common/sonar-architecture-api.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { TestHarness } from '../../harness';
import { INTENDED_RESOURCE } from '../../harness/fake-architecture';

// The CLI blocks Server, but its retained adapter is still tested directly.
describe('Server architecture adapter', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await TestHarness.create();
  });
  afterEach(async () => {
    await h.dispose();
  });
  const adapter = (url: string, project = 'shop') =>
    new SonarArchitectureApi(
      {
        auth: new ResolvedAuth({
          token: 'test-token',
          serverUrl: url,
          connectionType: 'on-premise',
          source: 'state',
        }),
        httpClient: new SonarHttpClient(url, 'test-token'),
      },
      project,
    );
  const model: IntendedArchitecture = {
    type: 'namespace',
    language: 'java',
    groups: [{ label: 'app', patterns: ['app:**'] }],
    constraints: [],
  };
  const directive = {
    type: 'REMOVE_EDGE',
    ecosystem: 'java',
    graphType: 'namespace_graph',
    fromNodeKey: 'app:a',
    toNodeKey: 'app:b',
  } as const;

  it('creates, updates and clears intended architecture using the public project lookup', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop', (p) => p.withNoDefaultBranch().withArchitecture(() => undefined))
      .start();
    const api = adapter(server.baseUrl());
    expect((await api.getIntendedState()).models).toEqual([]);
    await api.createIntended([model]);
    expect((await api.getIntended())[0]).toMatchObject(model);
    await api.updateIntended([{ ...model, description: 'Changed' }]);
    expect((await api.getIntended())[0].description).toBe('Changed');
    await api.deleteIntended();
    expect(await api.getIntended()).toEqual([]);
    const calls = server.getRecordedRequests();
    expect(calls.some((r) => r.path === '/api/v2/components/projects')).toBe(true);
    expect(calls.filter((r) => r.path.includes('project_branches'))).toHaveLength(0);
    expect(
      calls.filter((r) => ['POST', 'PATCH', 'DELETE'].includes(r.method)).map((r) => r.method),
    ).toEqual(['POST', 'PATCH', 'DELETE']);
  });

  it('creates, reads, updates and deletes an explicit directive', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop', (p) => p.withNoDefaultBranch().withArchitecture(() => undefined))
      .start();
    const api = adapter(server.baseUrl());
    const created = await api.createDirective(directive);
    expect(created).toMatchObject({
      ...directive,
      origin: 'sonarqube-cli',
      projectId: 'shop-project-id',
    });
    expect((await api.getDirectivesPage(1, 50)).directives).toHaveLength(1);
    const updated = await api.updateDirective(created.id, { ...directive, description: 'Changed' });
    expect(updated.description).toBe('Changed');
    await api.deleteDirective(created.id);
    expect((await api.getDirectivesPage(1, 50)).directives).toHaveLength(0);
    expect(
      server
        .getRecordedRequests()
        .filter((r) => ['POST', 'PATCH', 'DELETE'].includes(r.method))
        .map((r) => r.method),
    ).toEqual(['POST', 'PATCH', 'DELETE']);
  });

  it.each([
    [404, {}, 'public project lookup'],
    [401, {}, '401'],
    [403, {}, 'public project lookup'],
    [200, {}, 'resolve project'],
    [200, { projects: [], page: { total: 0 } }, 'resolve project'],
    [200, { projects: [{ id: 'opaque', key: 'other' }], page: { total: 1 } }, 'resolve project'],
    [200, { projects: [{ id: '', key: 'shop' }], page: { total: 1 } }, 'resolve project'],
    [200, { projects: [{ id: 12, key: 'shop' }], page: { total: 1 } }, 'resolve project'],
    [200, { projects: [{ id: 'opaque', key: 'shop' }], page: { total: 2 } }, 'resolve project'],
  ])('rejects an unusable lookup before any write (%s)', async (status, body, message) => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop')
      .withProjectsLookupResponse(status, body)
      .start();
    const error = await adapter(server.baseUrl())
      .createDirective(directive)
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    expect(
      server.getRecordedRequests().filter((r) => ['POST', 'PATCH', 'DELETE'].includes(r.method)),
    ).toHaveLength(0);
  });

  it('encodes the project key and uses the returned project id', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop:api-v2', (p) => p.withArchitecture(() => undefined))
      .start();
    await adapter(server.baseUrl(), 'shop:api-v2').getIntended();
    const calls = server.getRecordedRequests();
    expect(calls.find((r) => r.path === '/api/v2/components/projects')?.query.keys).toBe(
      'shop:api-v2',
    );
    expect(
      calls.find((r) => r.path === `/api/v2/architecture/${INTENDED_RESOURCE}`)?.query.projectId,
    ).toBe('shop:api-v2-project-id');
  });

  it('accepts an empty intended response with a null unsaved model id', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop', (p) =>
        p.withArchitecture((a) =>
          a.withStatus(INTENDED_RESOURCE, 200, '{"id":null,"intendedArchitectures":[]}', 'GET'),
        ),
      )
      .start();
    expect(await adapter(server.baseUrl()).getIntended()).toEqual([]);
  });
});

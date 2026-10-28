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
import type { ProjectDirective } from '@/commands/architecture/_common/directives.ts';

import { TestHarness } from '../../harness';

const input = {
  type: 'REMOVE_EDGE',
  ecosystem: 'java',
  graphType: 'namespace_graph',
  fromNodeKey: 'app:a',
  toNodeKey: 'app:b',
};
const model = {
  type: 'namespace',
  language: 'java',
  groups: [{ label: 'app', patterns: ['app:**'] }],
  constraints: [],
};

describe('Server public architecture project lookup', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await TestHarness.create();
    h.withExtraEnv({ SONARQUBE_CLI_ALPHA: 'false' });
  });
  afterEach(async () => {
    await h.dispose();
  });

  it('creates, previews, updates and clears intended architecture without an analyzed branch', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop', (p) => p.withNoDefaultBranch().withArchitecture(() => undefined))
      .start();
    h.withAuth(server.baseUrl(), 'test-token');
    const read = async () => {
      const result = await h.run('arch intended get -p shop --format json');
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout) as { revision: string; models: IntendedArchitecture[] };
    };
    const original = await read();
    expect(original.models).toEqual([]);
    h.cwd.writeFile('model.json', JSON.stringify({ ...original, models: [model] }));
    expect((await h.run('arch intended set -p shop --file model.json --dry-run')).exitCode).toBe(0);
    expect(server.getRecordedRequests().filter((r) => r.method === 'POST')).toHaveLength(0);
    expect((await h.run('arch intended set -p shop --file model.json')).exitCode).toBe(0);
    const saved = await read();
    h.cwd.writeFile(
      'model.json',
      JSON.stringify({ ...saved, models: [{ ...model, description: 'Changed' }] }),
    );
    expect((await h.run('arch intended set -p shop --file model.json')).exitCode).toBe(0);
    expect((await read()).models[0].description).toBe('Changed');
    h.cwd.writeFile('model.json', JSON.stringify({ ...(await read()), models: [] }));
    expect((await h.run('arch intended set -p shop --file model.json')).exitCode).toBe(0);
    expect((await read()).models).toEqual([]);
    const requests = server.getRecordedRequests();
    expect(requests.some((r) => r.path.includes('project_branches'))).toBe(false);
    const post = requests.find(
      (r) => r.method === 'POST' && r.path.endsWith('intended-architectures'),
    );
    expect(JSON.parse(post!.body!).projectId).toBe('shop-project-id');
    expect(requests.some((r) => r.path === '/api/v2/components/projects')).toBe(true);
  });

  it('runs directive CRUD and retains unspecified fields on Server', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop', (p) => p.withNoDefaultBranch().withArchitecture(() => undefined))
      .start();
    h.withAuth(server.baseUrl(), 'test-token');
    const apply = async (changes: unknown, dry = false) => {
      h.cwd.writeFile('changes.json', JSON.stringify(changes));
      const result = await h.run(
        'arch directives set -p shop --file changes.json' + (dry ? ' --dry-run' : ''),
      );
      expect(result.exitCode).toBe(0);
    };
    const read = async () => {
      const result = await h.run('arch directives get -p shop --format json');
      expect(result.exitCode).toBe(0);
      return (JSON.parse(result.stdout) as { directives: ProjectDirective[] }).directives;
    };
    await apply({ create: [input] }, true);
    expect(await read()).toHaveLength(0);
    await apply({ create: [{ ...input, origin: 'exported-client' }] });
    const id = (await read())[0].id;
    expect((await read())[0]).toMatchObject({
      graphPerspective: 'default_perspective',
      origin: 'sonarqube-cli',
    });
    const graphLookupCount = server
      .getRecordedRequests()
      .filter((r) => r.path.includes('project_branches')).length;
    await apply({ create: [{ ...input, graphPerspective: 'default_perspective' }] });
    expect(await read()).toHaveLength(1);
    await apply({ update: [{ id, description: 'Changed' }] });
    expect((await read())[0]).toMatchObject({
      ...input,
      description: 'Changed',
      origin: 'sonarqube-cli',
    });
    const patch = server.getRecordedRequests().find((r) => r.method === 'PATCH');
    expect(JSON.parse(patch!.body!)).not.toHaveProperty('graphPerspective');
    expect((await h.run(`arch directives get -p shop --id ${id} --format json`)).exitCode).toBe(0);
    await apply({ delete: [{ id }] });
    expect(await read()).toHaveLength(0);
    expect(
      server.getRecordedRequests().filter((r) => r.path.includes('project_branches')),
    ).toHaveLength(graphLookupCount);
  });

  it.each(['intended-architectures', 'project-directives'] as const)(
    'explains unavailable public Architecture APIs on Server (%s)',
    async (resource) => {
      const server = await h
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('shop', (p) =>
          p.withArchitecture((a) =>
            a.withStatus(resource, 404, '{"message":"Resource not found."}'),
          ),
        )
        .start();
      h.withAuth(server.baseUrl(), 'test-token');
      const target = resource === 'intended-architectures' ? 'intended' : 'directives';
      const result = await h.run(`arch ${target} get -p shop --format json`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('older Server versions');
      expect(result.stderr).toContain('public Architecture APIs');
      expect(result.stderr).toContain('Browse permission');
    },
  );

  it.each([
    [404, {}, 'public project lookup'],
    [401, {}, '401'],
    [403, {}, 'permissions'],
    [200, {}, 'resolve project'],
    [200, { projects: [], page: { total: 0 } }, 'resolve project'],
    [200, { projects: [{ id: 'opaque', key: 'other' }], page: { total: 1 } }, 'resolve project'],
    [200, { projects: [{ id: '', key: 'shop' }], page: { total: 1 } }, 'resolve project'],
    [200, { projects: [{ id: 12, key: 'shop' }], page: { total: 1 } }, 'resolve project'],
    [200, { projects: [{ id: 'opaque', key: 'shop' }], page: { total: 2 } }, 'resolve project'],
  ])('refuses an unusable lookup before any mutation (%s)', async (status, body, message) => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop')
      .withProjectsLookupResponse(status, body)
      .start();
    h.withAuth(server.baseUrl(), 'test-token');
    h.cwd.writeFile('changes.json', JSON.stringify({ create: [input] }));
    const result = await h.run('arch directives set -p shop --file changes.json');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
    expect(
      server.getRecordedRequests().filter((r) => ['POST', 'PATCH', 'DELETE'].includes(r.method)),
    ).toHaveLength(0);
  });

  it('reports confirmed creations and stops after a rejected update on Server', async () => {
    const id = '00000000-0000-4000-8000-000000000099';
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop', (p) =>
        p.withArchitecture((a) =>
          a
            .withDirectives([{ ...input, id, projectId: 'shop-project-id' } as ProjectDirective])
            .withStatus('project-directives', 403, '{"message":"update rejected"}', 'PATCH'),
        ),
      )
      .start();
    h.withAuth(server.baseUrl(), 'test-token');
    h.cwd.writeFile(
      'changes.json',
      JSON.stringify({
        create: [{ ...input, fromNodeKey: 'app:new' }],
        update: [{ id, description: 'Changed' }],
      }),
    );
    const result = await h.run('arch directives set -p shop --file changes.json');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('1 confirmed writes');
    const writes = server
      .getRecordedRequests()
      .filter((r) => ['POST', 'PATCH', 'DELETE'].includes(r.method));
    expect(writes.map((r) => r.method)).toEqual(['POST', 'PATCH']);
  });

  it('encodes the project key without changing the returned project id', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop:api-v2', (p) => p.withArchitecture(() => undefined))
      .start();
    h.withAuth(server.baseUrl(), 'test-token');
    const result = await h.run('arch intended get -p shop:api-v2 --format json');
    expect(result.exitCode).toBe(0);
    expect(
      server
        .getRecordedRequests()
        .some((r) => r.path === '/api/v2/architecture/intended-architectures'),
    ).toBe(true);
  });

  it('accepts an empty intended response with a null unsaved model id', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop', (p) =>
        p.withArchitecture((a) =>
          a.withStatus(
            'intended-architectures',
            200,
            '{"id":null,"intendedArchitectures":[]}',
            'GET',
          ),
        ),
      )
      .start();
    h.withAuth(server.baseUrl(), 'test-token');
    const result = await h.run('arch intended get -p shop --format json');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).models).toEqual([]);
  });
});

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
import { INTENDED_RESOURCE } from '../../harness/fake-architecture';

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

  const readIntended = async () => {
    const result = await h.run('arch intended get -p shop --format json');
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as { revision: string; models: IntendedArchitecture[] };
  };
  const readDirectives = async () => {
    const result = await h.run('arch directives get -p shop --format json');
    expect(result.exitCode).toBe(0);
    return (JSON.parse(result.stdout) as { directives: ProjectDirective[] }).directives;
  };
  const applyDirectives = async (changes: unknown, dry = false) => {
    h.cwd.writeFile('changes.json', JSON.stringify(changes));
    const result = await h.run(
      'arch directives set -p shop --file changes.json' + (dry ? ' --dry-run' : ''),
    );
    expect(result.exitCode).toBe(0);
  };
  const storedDirective = {
    ...input,
    id: '00000000-0000-4000-8000-000000000001',
    projectId: 'shop-project-id',
    graphPerspective: 'default_perspective',
    origin: 'sonarqube-cli',
  } as ProjectDirective;

  it('previews and creates intended architecture without an analyzed branch', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop', (p) => p.withNoDefaultBranch().withArchitecture(() => undefined))
      .start();
    h.withAuth(server.baseUrl(), 'test-token');
    const original = await readIntended();
    expect(original.models).toEqual([]);
    h.cwd.writeFile('model.json', JSON.stringify({ ...original, models: [model] }));
    expect((await h.run('arch intended set -p shop --file model.json --dry-run')).exitCode).toBe(0);
    expect(server.getRecordedRequests().filter((r) => r.method === 'POST')).toHaveLength(0);
    expect((await h.run('arch intended set -p shop --file model.json')).exitCode).toBe(0);
    const saved = await readIntended();
    expect(saved.models).toHaveLength(1);
    expect(saved.models[0]).toMatchObject(model);
    const requests = server.getRecordedRequests();
    expect(requests.some((r) => r.path.includes('project_branches'))).toBe(false);
    const post = requests.find((r) => r.method === 'POST' && r.path.endsWith(INTENDED_RESOURCE));
    expect(JSON.parse(post!.body!).projectId).toBe('shop-project-id');
    expect(requests.some((r) => r.path === '/api/v2/components/projects')).toBe(true);
  });

  it('updates and clears intended architecture without an analyzed branch', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop', (p) =>
        p
          .withNoDefaultBranch()
          .withArchitecture((a) => a.withIntended([model as IntendedArchitecture])),
      )
      .start();
    h.withAuth(server.baseUrl(), 'test-token');
    const saved = await readIntended();
    h.cwd.writeFile(
      'model.json',
      JSON.stringify({ ...saved, models: [{ ...model, description: 'Changed' }] }),
    );
    expect((await h.run('arch intended set -p shop --file model.json')).exitCode).toBe(0);
    const changed = await readIntended();
    expect(changed.models[0].description).toBe('Changed');
    h.cwd.writeFile('model.json', JSON.stringify({ ...changed, models: [] }));
    expect((await h.run('arch intended set -p shop --file model.json')).exitCode).toBe(0);
    expect((await readIntended()).models).toEqual([]);
    expect(server.getRecordedRequests().some((r) => r.path.includes('project_branches'))).toBe(
      false,
    );
  });

  it('previews and creates directives once on Server', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop', (p) => p.withNoDefaultBranch().withArchitecture(() => undefined))
      .start();
    h.withAuth(server.baseUrl(), 'test-token');
    await applyDirectives({ create: [input] }, true);
    expect(await readDirectives()).toHaveLength(0);
    await applyDirectives({ create: [{ ...input, origin: 'exported-client' }] });
    const saved = await readDirectives();
    expect(saved[0]).toMatchObject({
      graphPerspective: 'default_perspective',
      origin: 'sonarqube-cli',
    });
    const graphLookupCount = server
      .getRecordedRequests()
      .filter((r) => r.path.includes('project_branches')).length;
    await applyDirectives({ create: [{ ...input, graphPerspective: 'default_perspective' }] });
    expect(await readDirectives()).toHaveLength(1);
    expect(
      server.getRecordedRequests().filter((r) => r.path.includes('project_branches')),
    ).toHaveLength(graphLookupCount);
  });

  it('updates explicit directives and retains unspecified fields on Server', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop', (p) =>
        p.withNoDefaultBranch().withArchitecture((a) => a.withDirectives([storedDirective])),
      )
      .start();
    h.withAuth(server.baseUrl(), 'test-token');
    const id = storedDirective.id;
    await applyDirectives({ update: [{ id, description: 'Changed' }] });
    expect((await readDirectives())[0]).toMatchObject({
      ...input,
      description: 'Changed',
      origin: 'sonarqube-cli',
    });
    const patch = server.getRecordedRequests().find((r) => r.method === 'PATCH');
    expect(JSON.parse(patch!.body!)).not.toHaveProperty('graphPerspective');
    expect((await h.run(`arch directives get -p shop --id ${id} --format json`)).exitCode).toBe(0);
    expect(server.getRecordedRequests().some((r) => r.path.includes('project_branches'))).toBe(
      false,
    );
  });

  it('deletes only the explicit directive on Server', async () => {
    const sibling = {
      ...storedDirective,
      id: '00000000-0000-4000-8000-000000000002',
      toNodeKey: 'app:c',
    };
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop', (p) =>
        p
          .withNoDefaultBranch()
          .withArchitecture((a) => a.withDirectives([storedDirective, sibling])),
      )
      .start();
    h.withAuth(server.baseUrl(), 'test-token');
    await applyDirectives({ delete: [{ id: storedDirective.id }] });
    const remaining = await readDirectives();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject(sibling);
    expect(server.getRecordedRequests().some((r) => r.path.includes('project_branches'))).toBe(
      false,
    );
  });

  it.each([INTENDED_RESOURCE, 'project-directives'] as const)(
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
      const target = resource === INTENDED_RESOURCE ? 'intended' : 'directives';
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
    [403, {}, 'public project lookup'],
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

  it.each([
    'intended get -p shop --format json',
    'directives set -p shop --file changes.json --dry-run',
  ])(
    'attributes a denied project lookup to the lookup, before any Architecture call (%s)',
    async (command) => {
      const server = await h
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('shop')
        .withProjectsLookupResponse(403, { message: 'Lookup forbidden' })
        .start();
      h.withAuth(server.baseUrl(), 'test-token');
      h.cwd.writeFile('changes.json', JSON.stringify({ create: [input] }));
      const result = await h.run(`arch ${command}`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "The public project lookup refused access to 'shop' (HTTP 403).",
      );
      expect(result.stderr).toContain('Browse permission');
      expect(result.stderr).not.toContain('The Architecture API refused');
      expect(result.stderr).not.toContain('Team or Enterprise');
      expect(
        server.getRecordedRequests().filter((request) => request.path.includes('/architecture/')),
      ).toHaveLength(0);
    },
  );

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

  for (const cloud of [false, true]) {
    it(`reports a missing Architecture collection without blaming a resolved project on ${cloud ? 'Cloud' : 'Server'}`, async () => {
      const builder = h
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('shop', (p) =>
          p.withArchitecture((a) =>
            a.withStatus(INTENDED_RESOURCE, 404, '{"message":"Missing endpoint"}', 'GET'),
          ),
        );
      const server = await (cloud ? builder.asSonarCloud() : builder).start();
      h.withAuth(
        cloud ? server.recordedAuthServerUrl() : server.baseUrl(),
        'test-token',
        cloud ? 'my-org' : undefined,
      );
      const result = await h.run('arch intended get -p shop --format json');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('public Architecture API endpoint');
      expect(result.stderr).not.toContain("Project 'shop' or its architecture was not found");
      const lookup = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/v2/components/projects');
      expect(lookup).toHaveLength(cloud ? 0 : 1);
      if (cloud) expect(result.stderr).not.toContain('older Server versions');
      else expect(result.stderr).toContain('older Server versions');
    });
  }

  for (const cloud of [false, true]) {
    it(`keeps missing-project guidance separate from Server API availability on ${cloud ? 'Cloud' : 'Server'}`, async () => {
      const builder = h.newFakeServer().withAuthToken('test-token').withProject('shop');
      const server = await (cloud ? builder.asSonarCloud() : builder).start();
      h.withAuth(
        cloud ? server.recordedAuthServerUrl() : server.baseUrl(),
        'test-token',
        cloud ? 'my-org' : undefined,
      );
      const result = await h.run('arch current get -p missing --language java --format json');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Project 'missing' or its architecture was not found");
      expect(result.stderr).toContain('Browse permission');
      expect(result.stderr).not.toContain('older Server versions');
      expect(
        server.getRecordedRequests().filter((r) => r.path.includes('/architecture/')),
      ).toHaveLength(0);
    });
  }

  it('encodes the project key without changing the returned project id', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('shop:api-v2', (p) => p.withArchitecture(() => undefined))
      .start();
    h.withAuth(server.baseUrl(), 'test-token');
    const result = await h.run('arch intended get -p shop:api-v2 --format json');
    expect(result.exitCode).toBe(0);
    const requests = server.getRecordedRequests();
    expect(requests.find((r) => r.path === '/api/v2/components/projects')?.query.keys).toBe(
      'shop:api-v2',
    );
    expect(
      requests.find((r) => r.path === `/api/v2/architecture/${INTENDED_RESOURCE}`)?.query.projectId,
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
    h.withAuth(server.baseUrl(), 'test-token');
    const result = await h.run('arch intended get -p shop --format json');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).models).toEqual([]);
  });
});

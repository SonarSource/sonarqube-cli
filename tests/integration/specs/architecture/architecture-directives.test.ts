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

// Integration tests for architecture reads on the public architecture API

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { DirectiveInput } from '@/commands/architecture/_common/directives.ts';

import { TestHarness } from '../../harness';
const directive: DirectiveInput = {
  type: 'REMOVE_EDGE',
  ecosystem: 'java',
  graphType: 'namespace_graph',
  fromNodeKey: 'app:a',
  toNodeKey: 'app:b',
};
describe('public project directives', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await TestHarness.create();
  });
  afterEach(async () => {
    await h.dispose();
  });

  it.each(['get'])(
    'identifies an unknown directive without blaming the project: %s',
    async (operation: string) => {
      const server = await configured();
      const id = '00000000-0000-4000-8000-000000000999';
      h.cwd.writeFile(
        'changes.json',
        JSON.stringify({
          create: [directive],
          [operation]: [{ id, ...(operation === 'update' ? { description: 'updated' } : {}) }],
        }),
      );
      const result = await h.run(
        operation === 'get'
          ? `arch directives get -p shop --id ${id}`
          : 'arch directives set -p shop --file changes.json',
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`Directive ${id} was not found`);
      expect(result.stderr).not.toContain('sonar list projects');
      expect(
        server
          .getRecordedRequests()
          .filter(
            (r) =>
              ['POST', 'PATCH', 'DELETE'].includes(r.method) &&
              r.path.includes('project-directives'),
          ),
      ).toHaveLength(0);
    },
  );

  it('does not suggest another page for an empty project', async () => {
    await configured();
    const read = await h.run('arch directives get -p shop --format text');
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain('No directives are visible');
    expect(read.stdout).not.toContain('Use --page to continue');
  });
  async function configured(
    configure: (api: import('../../harness/fake-architecture').FakeArchitecture) => void = () => {},
  ) {
    const server = await h
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('directive-token')
      .withProject('shop', (project) => project.withArchitecture(configure))
      .start();
    h.withAuth(server.recordedAuthServerUrl(), 'directive-token', 'my-org');
    h.cwd.writeFile('directives.json', JSON.stringify({ create: [directive] }));
    return server;
  }

  it.each([
    { pageIndex: 1, total: 0, copies: 1 },
    { pageIndex: 2, total: 1, copies: 1 },
    { pageIndex: 1, total: 3, copies: 1 },
    { pageIndex: 1, total: 1, copies: 0 },
  ])(
    'accepts count drift on display reads: %j',
    async ({ pageIndex, total, copies }) => {
      const saved = {
        ...directive,
        id: '00000000-0000-4000-8000-000000000001',
        projectId: 'shop-branch-id',
      };
      const server = await configured((api) =>
        api.withStatus(
          'project-directives',
          200,
          JSON.stringify({
            projectDirectives: Array.from({ length: copies }, () => saved),
            page: { pageIndex, pageSize: 100, total },
          }),
          'GET',
        ),
      );
      const result = await h.run(`arch directives get -p shop --page ${pageIndex} --page-size 100`);
      expect(result.exitCode).toBe(0);
      expect(server.getRecordedRequests().some((request) => request.method === 'POST')).toBe(false);
    },
  );

  it.each([
    { pageIndex: 1, total: 2, copies: 2 },
  ])(
    'rejects inconsistent public pages on direct reads: %j',
    async ({ pageIndex, total, copies }) => {
      const saved = {
        ...directive,
        id: '00000000-0000-4000-8000-000000000001',
        projectId: 'shop-branch-id',
      };
      const server = await configured((api) =>
        api.withStatus(
          'project-directives',
          200,
          JSON.stringify({
            projectDirectives: Array.from({ length: copies }, () => saved),
            page: { pageIndex, pageSize: 100, total },
          }),
          'GET',
        ),
      );
      const result = await h.run(`arch directives get -p shop --page ${pageIndex} --page-size 100`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('duplicate ids');
      expect(server.getRecordedRequests().some((request) => request.method === 'POST')).toBe(false);
    },
  );

  it('rejects an empty successful directives response', async () => {
    const server = await configured((api) => api.withStatus('project-directives', 200, '', 'GET'));
    const result = await h.run('arch directives get -p shop');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid public directives page');
    expect(server.getRecordedRequests().some((request) => request.method === 'POST')).toBe(false);
  });

  it.each([0, -1, 1001])(
    'rejects an invalid page size %i without fetching a directives page',
    async (size) => {
      const server = await configured();
      const result = await h.run('arch directives get -p shop --page-size ' + size);
      expect(result.exitCode).toBe(1);
      expect(
        server.getRecordedRequests().filter((r) => r.path.includes('project-directives')),
      ).toHaveLength(0);
    },
  );
  it('reads a stored directive by id and preserves its fields', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    await configured((api) =>
      api.withDirectives([{ ...directive, id, projectId: 'shop-branch-id' }]),
    );
    const result = await h.run(`arch directives get -p shop --id ${id} --format json`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).directive).toMatchObject({ ...directive, id });
  });
  it.each([
    { type: 'UNKNOWN' },
    { ecosystem: 'unknown' },
    { graphType: 'unknown' },
    { id: 'invalid' },
    { origin: 42 },
    { description: 42 },
    { graphPerspective: 42 },
    { projectId: '' },
    { fromNodeKey: '' },
  ])('rejects malformed stored fields without writing: %j', async (invalid) => {
    const id = '00000000-0000-4000-8000-000000000001';
    const saved = { ...directive, id, projectId: 'shop-branch-id', ...invalid };
    const server = await configured((api) =>
      api
        .withDirectives([{ ...directive, id, projectId: 'shop-branch-id' }])
        .withStatus('project-directives', 200, JSON.stringify(saved), 'GET'),
    );
    const result = await h.run(`arch directives get -p shop --id ${id}`);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('was not found');
    expect(
      server.getRecordedRequests().some((r) => ['POST', 'PATCH', 'DELETE'].includes(r.method)),
    ).toBe(false);
  });

  it('shows stored optional fields in JSON and both text read modes', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    await configured((api) =>
      api.withDirectives([
        {
          ...directive,
          id,
          projectId: 'shop-branch-id',
          graphPerspective: 'custom',
          description: 'Saved description',
          origin: 'web',
        },
      ]),
    );
    const json = await h.run(`arch directives get -p shop --id ${id} --format json`);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout).directive).toMatchObject({
      graphPerspective: 'custom',
      description: 'Saved description',
      origin: 'web',
    });
    const single = await h.run(`arch directives get -p shop --id ${id} --format text`);
    expect(single.exitCode).toBe(0);
    expect(single.stdout).toContain(`${id}: REMOVE_EDGE app:a -> app:b`);
    const page = await h.run('arch directives get -p shop --format text');
    expect(page.exitCode).toBe(0);
    expect(page.stdout).toContain('[custom] app:a -> app:b');
  });

  it('reads populated pages and preserves pagination metadata', async () => {
    const rows = [1, 2].map((n) => ({
      ...directive,
      id: `00000000-0000-4000-8000-00000000000${n}`,
      projectId: 'shop-branch-id',
    }));
    await configured((api) => api.withDirectives(rows));
    for (const pageIndex of [1, 2]) {
      const read = await h.run(
        `arch directives get -p shop --page ${pageIndex} --page-size 1 --format json`,
      );
      expect(read.exitCode).toBe(0);
      const result = JSON.parse(read.stdout);
      expect(result.directives).toHaveLength(1);
      expect(result.directives[0]).toMatchObject(rows[pageIndex - 1]);
      expect(result.page).toEqual({ pageIndex, pageSize: 1, total: 2 });
    }
  });

  it.each(['wrong-project', 'wrong-id', 'missing-key'])(
    'rejects a mismatched or incomplete single directive: %s',
    async (kind) => {
      const id = '00000000-0000-4000-8000-000000000001';
      const saved = {
        ...directive,
        id,
        projectId: 'shop-branch-id',
        ...(kind === 'wrong-project' ? { projectId: 'different' } : {}),
        ...(kind === 'wrong-id' ? { id: '00000000-0000-4000-8000-000000000002' } : {}),
        ...(kind === 'missing-key' ? { fromNodeKey: null } : {}),
      };
      const server = await configured((api) =>
        api
          .withDirectives([{ ...directive, id, projectId: 'shop-branch-id' }])
          .withStatus('project-directives', 200, JSON.stringify(saved), 'GET'),
      );
      const result = await h.run(`arch directives get -p shop --id ${id}`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        kind === 'missing-key' ? 'fromNodeKey' : 'different id or project',
      );
      expect(
        server.getRecordedRequests().filter((r) => ['POST', 'PATCH', 'DELETE'].includes(r.method)),
      ).toHaveLength(0);
    },
  );

  it('refuses pagination together with an explicit id before requesting directives', async () => {
    const server = await configured();
    const result = await h.run(
      'arch directives get -p shop --id 00000000-0000-4000-8000-000000000001 --page 1',
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Use either --id or pagination');
    expect(
      server.getRecordedRequests().filter((r) => r.path.includes('project-directives')),
    ).toHaveLength(0);
  });

  it.each([401, 403])(
    'relays read access failures without sending a mutation: %d',
    async (status) => {
      const server = await configured((api) =>
        api.withStatus('project-directives', status, '{"message":"Access denied"}', 'GET'),
      );
      expect((await h.run('arch directives get -p shop')).exitCode).not.toBe(0);
      expect(
        server.getRecordedRequests().filter((r) => ['POST', 'PATCH', 'DELETE'].includes(r.method)),
      ).toHaveLength(0);
    },
  );
});

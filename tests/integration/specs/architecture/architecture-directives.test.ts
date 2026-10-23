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

import type {
  DirectiveInput,
  ProjectDirective,
} from '@/commands/architecture/_common/directives.ts';
import { ALPHA_ENV_VAR } from '@/core/commands/stage.ts';

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
    h.withExtraEnv({ [ALPHA_ENV_VAR]: 'true' });
  });
  afterEach(async () => {
    await h.dispose();
  });
  function deleteCommand(id: string): string {
    h.cwd.writeFile('deletes.json', JSON.stringify({ delete: [{ id }] }));
    return 'arch directives set -p shop --file deletes.json';
  }
  it('previews and applies a mixed change file, preserving unmentioned directives and unchanged fields', async () => {
    const first = '00000000-0000-4000-8000-000000000001';
    const second = '00000000-0000-4000-8000-000000000002';
    const retained = '00000000-0000-4000-8000-000000000003';
    const original = {
      ...directive,
      id: first,
      projectId: 'shop-branch-id',
      description: 'before',
      origin: 'SONAR_CLI',
    };
    const server = await h
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('token')
      .withProject('shop', (p) =>
        p.withArchitecture((a) =>
          a.withDirectives([
            original,
            { ...original, id: second, fromNodeKey: 'delete:me' },
            { ...original, id: retained, fromNodeKey: 'retain:me' },
          ]),
        ),
      )
      .start();
    h.withAuth(server.recordedAuthServerUrl(), 'token', 'my-org');
    const added = { ...directive, fromNodeKey: 'new:source' };
    h.cwd.writeFile(
      'changes.json',
      JSON.stringify({
        create: [added, added],
        update: [{ id: first, description: 'after' }],
        delete: [{ id: second }],
      }),
    );
    const preview = await h.run('arch directives set -p shop --file changes.json --dry-run');
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('Would create');
    expect(preview.stdout).toContain('Would update');
    expect(preview.stdout).toContain('Would delete');
    expect(preview.stdout).toContain('before');
    expect(preview.stdout).toContain('after');
    expect(
      server
        .getRecordedRequests()
        .filter(
          (r) =>
            ['POST', 'PATCH', 'DELETE'].includes(r.method) && r.path.includes('project-directives'),
        ),
    ).toHaveLength(0);
    const apply = await h.run('arch directives set -p shop --file changes.json');
    expect(apply.exitCode).toBe(0);
    const mutations = server
      .getRecordedRequests()
      .filter(
        (r) =>
          ['POST', 'PATCH', 'DELETE'].includes(r.method) && r.path.includes('project-directives'),
      );
    expect(mutations.map((r) => r.method)).toEqual(['POST', 'PATCH', 'DELETE']);
    const read = await h.run('arch directives get -p shop --format json');
    const rows = JSON.parse(read.stdout).directives as ProjectDirective[];
    expect(rows).toHaveLength(3);
    expect(rows.find((d) => d.id === first)).toEqual({ ...original, description: 'after' });
    expect(rows.some((d) => d.id === second)).toBe(false);
    expect(rows.find((d) => d.id === retained)?.fromNodeKey).toBe('retain:me');
    h.cwd.writeFile(
      'changes.json',
      JSON.stringify({ create: [added], update: [{ id: first, description: 'after' }] }),
    );
    expect((await h.run('arch directives set -p shop --file changes.json')).exitCode).toBe(0);
    expect(
      server
        .getRecordedRequests()
        .filter(
          (r) =>
            ['POST', 'PATCH', 'DELETE'].includes(r.method) && r.path.includes('project-directives'),
        ),
    ).toHaveLength(3);
  });

  it.each([
    { value: [] },
    { directives: [directive] },
    { create: null },
    { update: null },
    { delete: null },
    { unknown: [] },
    { create: [directive], update: [{ id: 'invalid' }] },
    {
      create: [directive],
      update: [{ id: '00000000-0000-4000-8000-000000000001', description: null }],
    },
    {
      update: [{ id: '00000000-0000-4000-8000-000000000001' }],
      delete: [{ id: '00000000-0000-4000-8000-000000000001' }],
    },
    { delete: [{ id: '00000000-0000-4000-8000-000000000001', description: 'wrong' }] },
  ])('refuses invalid or conflicting change files before any write: %j', async (input) => {
    const value = 'value' in input ? input.value : input;
    const server = await h
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('token')
      .withProject('shop', (p) =>
        p.withArchitecture((a) =>
          a.withDirectives([
            {
              ...directive,
              id: '00000000-0000-4000-8000-000000000001',
              projectId: 'shop-branch-id',
            },
          ]),
        ),
      )
      .start();
    h.withAuth(server.recordedAuthServerUrl(), 'token', 'my-org');
    h.cwd.writeFile('changes.json', JSON.stringify(value));
    expect((await h.run('arch directives set -p shop --file changes.json')).exitCode).not.toBe(0);
    expect(
      server
        .getRecordedRequests()
        .filter(
          (r) =>
            ['POST', 'PATCH', 'DELETE'].includes(r.method) && r.path.includes('project-directives'),
        ),
    ).toHaveLength(0);
  });

  it('stops a mixed batch after a rejected update and reports the confirmed creation without deleting', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const server = await h
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('token')
      .withProject('shop', (p) =>
        p.withArchitecture((a) =>
          a
            .withDirectives([{ ...directive, id, projectId: 'shop-branch-id' }])
            .withStatus('project-directives', 403, '{"message":"update rejected"}', 'PATCH'),
        ),
      )
      .start();
    h.withAuth(server.recordedAuthServerUrl(), 'token', 'my-org');
    h.cwd.writeFile(
      'changes.json',
      JSON.stringify({
        create: [{ ...directive, fromNodeKey: 'new:source' }],
        update: [{ id, description: 'changed' }],
      }),
    );
    const result = await h.run('arch directives set -p shop --file changes.json');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('stopped after 1 confirmed writes');
    expect(result.stderr).toMatch(/Created ids: [0-9a-f-]{36}/);
    expect(
      server
        .getRecordedRequests()
        .filter(
          (r) =>
            ['POST', 'PATCH', 'DELETE'].includes(r.method) && r.path.includes('project-directives'),
        )
        .map((r) => r.method),
    ).toEqual(['POST', 'PATCH']);
  });

  it('accepts an empty change file as a no-op and rejects create/delete of the same operation', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const server = await h
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('token')
      .withProject('shop', (p) =>
        p.withArchitecture((a) =>
          a.withDirectives([{ ...directive, id, projectId: 'shop-branch-id' }]),
        ),
      )
      .start();
    h.withAuth(server.recordedAuthServerUrl(), 'token', 'my-org');
    h.cwd.writeFile('changes.json', '{}');
    expect((await h.run('arch directives set -p shop --file changes.json')).exitCode).toBe(0);
    h.cwd.writeFile('changes.json', JSON.stringify({ create: [directive], delete: [{ id }] }));
    const conflict = await h.run('arch directives set -p shop --file changes.json');
    expect(conflict.exitCode).not.toBe(0);
    expect(conflict.stderr).toContain('conflicts');
    expect(
      server
        .getRecordedRequests()
        .filter(
          (r) =>
            ['POST', 'PATCH', 'DELETE'].includes(r.method) && r.path.includes('project-directives'),
        ),
    ).toHaveLength(0);
  });

  it('shows perspectives and descriptions in create previews', async () => {
    const server = await h
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('token')
      .withProject('shop', (p) => p.withArchitecture((a) => a.withDirectives([])))
      .start();
    h.withAuth(server.recordedAuthServerUrl(), 'token', 'my-org');
    h.cwd.writeFile(
      'changes.json',
      JSON.stringify({
        create: [
          { ...directive, graphPerspective: 'First', description: 'Explain first' },
          { ...directive, graphPerspective: 'Second', description: 'Explain second' },
        ],
      }),
    );
    const preview = await h.run('arch directives set -p shop --file changes.json --dry-run');
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('[First]');
    expect(preview.stdout).toContain('[Second]');
    expect(preview.stdout).toContain('Explain first');
    expect(preview.stdout).toContain('Explain second');
    expect(
      server
        .getRecordedRequests()
        .filter((r) => r.method === 'POST' && r.path.includes('project-directives')),
    ).toHaveLength(0);
  });

  it('exposes only get and set, with explicit mutation operations', async () => {
    const help = await h.run('arch directives --help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('get');
    expect(help.stdout).toContain('set');
    const setHelp = await h.run('arch directives set --help');
    expect(setHelp.stdout).toContain('--file');
    expect(setHelp.stdout).not.toContain('--operation');
    for (const verb of ['add', 'update', 'delete']) {
      const legacy = await h.run(`arch directives ${verb}`);
      expect(legacy.exitCode).not.toBe(0);
      expect(legacy.stderr).toMatch(/unknown command/i);
    }
  });

  it.each([
    '--operation delete --file directives.json',
    '--operation create --id 00000000-0000-4000-8000-000000000001',
    '--operation update',
    '--operation replace --file directives.json',
  ])('rejects invalid set options without mutation: %s', async (flags) => {
    const server = await h
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('token')
      .withProject('shop', (p) => p.withArchitecture((a) => a.withDirectives([])))
      .start();
    h.withAuth(server.recordedAuthServerUrl(), 'token', 'my-org');
    h.cwd.writeFile('directives.json', JSON.stringify({ create: [directive] }));
    expect((await h.run(`arch directives set -p shop ${flags}`)).exitCode).not.toBe(0);
    expect(
      server
        .getRecordedRequests()
        .filter(
          (r) =>
            ['POST', 'PATCH', 'DELETE'].includes(r.method) && r.path.includes('project-directives'),
        ),
    ).toHaveLength(0);
  });

  it('reads, previews, updates and deletes explicit ids without changing other directives', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const other = '00000000-0000-4000-8000-000000000002';
    const existing = [
      {
        ...directive,
        id,
        projectId: 'shop-branch-id',
        description: 'original',
        origin: 'SONAR_CLI',
      },
      { ...directive, id: other, projectId: 'shop-branch-id', fromNodeKey: 'other' },
    ];
    const server = await h
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('token')
      .withProject('shop', (p) => p.withArchitecture((a) => a.withDirectives(existing)))
      .start();
    h.withAuth(server.recordedAuthServerUrl(), 'token', 'my-org');
    const read = await h.run(`arch directives get -p shop --id ${id} --format json`);
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(read.stdout).directive.description).toBe('original');
    h.cwd.writeFile('updates.json', JSON.stringify({ update: [{ id, description: 'updated' }] }));
    const preview = await h.run('arch directives set -p shop --file updates.json --dry-run');
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('Would update');
    expect(preview.stdout).toContain('original');
    expect(preview.stdout).toContain('updated');
    expect(server.getRecordedRequests().filter((r) => r.method === 'PATCH')).toHaveLength(0);
    const apply = await h.run('arch directives set -p shop --file updates.json');
    expect(apply.exitCode).toBe(0);
    const updated = await h.run(`arch directives get -p shop --id ${id} --format json`);
    expect(JSON.parse(updated.stdout).directive).toMatchObject({
      ...existing[0],
      description: 'updated',
    });
    const noop = await h.run('arch directives set -p shop --file updates.json');
    expect(noop.stdout).toMatch(/Skipped 1.*unchanged/);
    expect(server.getRecordedRequests().filter((r) => r.method === 'PATCH')).toHaveLength(1);
    const deletion = await h.run(deleteCommand(id) + ' --dry-run');
    expect(deletion.exitCode).toBe(0);
    expect(server.getRecordedRequests().filter((r) => r.method === 'DELETE')).toHaveLength(0);
    const removed = await h.run(deleteCommand(id));
    expect(removed.exitCode).toBe(0);
    expect((await h.run(`arch directives get -p shop --id ${id}`)).exitCode).not.toBe(0);
    const list = await h.run('arch directives get -p shop --format json');
    expect(JSON.parse(list.stdout).directives.map((d: ProjectDirective) => d.id)).toEqual([other]);
    const patch = server.getRecordedRequests().find((r) => r.method === 'PATCH')!;
    expect(JSON.parse(patch.body!)).toEqual({ ...directive, description: 'updated' });
  });

  it.each([
    [{ id: 'not-an-id', description: 'changed' }],
    [{ id: '00000000-0000-4000-8000-000000000001', description: null }],
    [{ id: '00000000-0000-4000-8000-000000000001', surprise: true }],
    [
      { id: '00000000-0000-4000-8000-000000000001' },
      { id: '00000000-0000-4000-8000-000000000001' },
    ],
  ])('rejects invalid updates before writing: %j', async (...items) => {
    const server = await h
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('token')
      .withProject('shop', (p) => p.withArchitecture((a) => a.withDirectives([])))
      .start();
    h.withAuth(server.recordedAuthServerUrl(), 'token', 'my-org');
    h.cwd.writeFile('updates.json', JSON.stringify({ update: items }));
    expect((await h.run('arch directives set -p shop --file updates.json')).exitCode).not.toBe(0);
    expect(
      server.getRecordedRequests().filter((r) => ['PATCH', 'DELETE'].includes(r.method)),
    ).toHaveLength(0);
  });

  it.each([400, 403, 429, 500])(
    'does not retry rejected or uncertain updates/deletes (%d)',
    async (status) => {
      const id = '00000000-0000-4000-8000-000000000001';
      const server = await h
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken('token')
        .withProject('shop', (p) =>
          p.withArchitecture((a) =>
            a
              .withDirectives([{ ...directive, id, projectId: 'shop-branch-id' }])
              .withStatus('project-directives', status, '{"message":"rejected"}', 'PATCH')
              .withStatus('project-directives', status, '{"message":"rejected"}', 'DELETE'),
          ),
        )
        .start();
      h.withAuth(server.recordedAuthServerUrl(), 'token', 'my-org');
      h.cwd.writeFile('updates.json', JSON.stringify({ update: [{ id, description: 'changed' }] }));
      const update = await h.run('arch directives set -p shop --file updates.json');
      const deletion = await h.run(deleteCommand(id));
      expect(update.exitCode).not.toBe(0);
      expect(deletion.exitCode).not.toBe(0);
      expect(server.getRecordedRequests().filter((r) => r.method === 'PATCH')).toHaveLength(1);
      expect(server.getRecordedRequests().filter((r) => r.method === 'DELETE')).toHaveLength(1);
      if (status === 500) {
        expect(update.stderr).toContain(`Inspect directive ${id}`);
        expect(deletion.stderr).toContain(`Inspect directive ${id}`);
      }
    },
  );

  it('rejects a targeted directive from another project before mutation', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const wrong = { ...directive, id, projectId: 'other-branch-id' };
    const server = await h
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('token')
      .withProject('shop', (p) =>
        p.withArchitecture((a) =>
          a
            .withDirectives([{ ...wrong, projectId: 'shop-branch-id' }])
            .withStatus('project-directives', 200, JSON.stringify(wrong), 'GET'),
        ),
      )
      .start();
    h.withAuth(server.recordedAuthServerUrl(), 'token', 'my-org');
    h.cwd.writeFile('updates.json', JSON.stringify({ update: [{ id, description: 'changed' }] }));
    expect((await h.run('arch directives set -p shop --file updates.json')).exitCode).not.toBe(0);
    expect((await h.run(deleteCommand(id))).exitCode).not.toBe(0);
    expect(
      server.getRecordedRequests().filter((r) => ['PATCH', 'DELETE'].includes(r.method)),
    ).toHaveLength(0);
  });

  it.each([200, 403, 429])(
    'does not claim confirmed deletion from a readback with HTTP %d',
    async (status) => {
      const id = '00000000-0000-4000-8000-000000000001';
      const server = await h
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken('token')
        .withProject('shop', (p) =>
          p.withArchitecture((a) =>
            a
              .withDirectives([{ ...directive, id, projectId: 'shop-branch-id' }])
              .withDirectiveDeleteReadResponse(
                status,
                status === 200 ? 'null' : '{"message":"read denied"}',
              ),
          ),
        )
        .start();
      h.withAuth(server.recordedAuthServerUrl(), 'token', 'my-org');
      const deletion = await h.run(deleteCommand(id));
      expect(deletion.exitCode).not.toBe(0);
      expect(deletion.stderr).toContain('deletion could not be confirmed');
      expect(deletion.stderr).toContain(`Inspect directive ${id}`);
      expect(server.getRecordedRequests().filter((r) => r.method === 'DELETE')).toHaveLength(1);
    },
  );

  it('lists every page for duplicate checks, previews and creates additively', async () => {
    const existing: ProjectDirective[] = Array.from({ length: 101 }, (_, i) => ({
      ...directive,
      type: 'REMOVE_EDGE',
      ecosystem: 'java',
      graphType: 'namespace_graph',
      fromNodeKey: 'app:' + i,
      id: '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
      projectId: 'shop-branch-id',
    }));
    const s = await h
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('directive-token')
      .withProject('shop', (p) => p.withArchitecture((a) => a.withDirectives(existing)))
      .start();
    h.withAuth(s.recordedAuthServerUrl(), 'directive-token', 'my-org');
    const read = await h.run('arch directives get -p shop --format json');
    expect(read.exitCode).toBe(0);
    expect(JSON.parse(read.stdout).directives).toHaveLength(50);
    expect(JSON.parse(read.stdout).page.total).toBe(101);
    const secondPage = await h.run(
      'arch directives get -p shop --format json --page 2 --page-size 100',
    );
    expect(secondPage.exitCode).toBe(0);
    expect(JSON.parse(secondPage.stdout).directives).toHaveLength(1);
    h.cwd.writeFile(
      'directives.json',
      JSON.stringify({ create: [existing[100], directive, directive] }),
    );
    const preview = await h.run('arch directives set -p shop --file directives.json --dry-run');
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('Skipped 2');
    expect(
      s
        .getRecordedRequests()
        .filter((r) => r.method === 'POST' && r.path.includes('project-directives')),
    ).toHaveLength(0);
    const apply = await h.run('arch directives set -p shop --file directives.json');
    expect(apply.exitCode).toBe(0);
    expect(apply.stdout).toContain('Created 1 directives');
    const noop = await h.run('arch directives set -p shop --file directives.json');
    expect(noop.exitCode).toBe(0);
    expect(noop.stdout).toContain('Created 0 directives');
    const posts = s
      .getRecordedRequests()
      .filter((r) => r.method === 'POST' && r.path.includes('project-directives'));
    expect(posts).toHaveLength(1);
    expect(
      s
        .getRecordedRequests()
        .filter(
          (r) => ['PATCH', 'DELETE'].includes(r.method) && r.path.includes('project-directives'),
        ),
    ).toHaveLength(0);
  });
  it('relays a backend permission refusal without creating or replacing directives', async () => {
    const s = await h
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('directive-token')
      .withProject('shop', (p) =>
        p.withArchitecture((a) =>
          a.withStatus(
            'project-directives',
            403,
            '{"message":"Missing architecture permission"}',
            'POST',
          ),
        ),
      )
      .start();
    h.withAuth(s.recordedAuthServerUrl(), 'directive-token', 'my-org');
    h.cwd.writeFile('directives.json', JSON.stringify({ create: [directive] }));
    const result = await h.run('arch directives set -p shop --file directives.json');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('permission');
    expect(
      s
        .getRecordedRequests()
        .filter((r) => r.method === 'POST' && r.path.includes('project-directives')),
    ).toHaveLength(1);
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

  it.each(
    [
      { project: 'other', create: [directive] },
      { projectKey: 'other', create: [directive] },
      { create: null },
      [{ ...directive, type: 'WRONG' }],
      [{ ...directive, fromNode: 'typo' }],
      [{ ...directive, ecosystem: 4 }],
      [{ ...directive, graphType: 'UNKNOWN' }],
      [{ ...directive, fromNodeKey: '' }],
      [{ ...directive, description: 4 }],
    ].map((value) => ({ value })),
  )(
    'rejects invalid or wrong-project input before Architecture requests: %j',
    async ({ value }) => {
      const server = await configured();
      h.cwd.writeFile(
        'directives.json',
        JSON.stringify(Array.isArray(value) ? { create: value } : value),
      );
      const result = await h.run('arch directives set -p shop --file directives.json');
      expect(result.exitCode).toBe(1);
      expect(
        server.getRecordedRequests().filter((r) => r.path.includes('/architecture/')),
      ).toHaveLength(0);
    },
  );

  it.each([
    { pageIndex: 1, total: 0, copies: 1 },
    { pageIndex: 2, total: 1, copies: 1 },
    { pageIndex: 1, total: 3, copies: 1 },
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
      expect(result.stderr).toContain('public directives page');
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

  it.each([400, 403, 429])(
    'relays a definite %i rejection without retrying or claiming an uncertain write',
    async (status) => {
      const server = await configured((api) =>
        api.withStatus('project-directives', status, '{"message":"Directive rejected"}', 'POST'),
      );
      const result = await h.run('arch directives set -p shop --file directives.json');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toContain('may already exist');
      expect(
        server
          .getRecordedRequests()
          .filter((r) => r.method === 'POST' && r.path.includes('project-directives')),
      ).toHaveLength(1);
    },
  );

  it.each(['malformed', 'wrong-node', 'server-error'])(
    'reports an uncertain %s response without retrying',
    async (kind) => {
      const response =
        kind === 'wrong-node'
          ? {
              ...directive,
              fromNodeKey: 'different',
              projectId: 'shop-branch-id',
              id: '00000000-0000-4000-8000-000000000001',
            }
          : {};
      const server = await configured((api) =>
        api.withStatus(
          'project-directives',
          kind === 'server-error' ? 500 : 201,
          JSON.stringify(response),
          'POST',
        ),
      );
      const result = await h.run('arch directives set -p shop --file directives.json');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('attempted change may already have been applied');
      expect(
        server
          .getRecordedRequests()
          .filter((r) => r.method === 'POST' && r.path.includes('project-directives')),
      ).toHaveLength(1);
    },
  );

  it('reports confirmed IDs after a partial failure and does not roll back or retry', async () => {
    const server = await configured((api) => {
      const original = api.handle.bind(api);
      let posts = 0;
      api.handle = (resource, request) =>
        resource === 'project-directives' && request.method === 'POST' && ++posts === 2
          ? Response.json({ message: 'Missing architecture permission' }, { status: 403 })
          : original(resource, request);
    });
    h.cwd.writeFile(
      'directives.json',
      JSON.stringify({ create: [directive, { ...directive, type: 'MOVE_NODE' }] }),
    );
    const result = await h.run('arch directives set -p shop --file directives.json');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('stopped after 1 confirmed writes');
    expect(result.stderr).toMatch(/Created ids: [0-9a-f-]{36}/);
    const mutations = server
      .getRecordedRequests()
      .filter(
        (r) =>
          ['POST', 'PATCH', 'DELETE'].includes(r.method) && r.path.includes('project-directives'),
      );
    expect(mutations.map((r) => r.method)).toEqual(['POST', 'POST']);
    const read = await h.run('arch directives get -p shop --format json');
    expect(JSON.parse(read.stdout).directives).toHaveLength(1);
  });

  it('refuses changed pagination totals before creating directives', async () => {
    const items: ProjectDirective[] = Array.from({ length: 100 }, (_, i) => ({
      ...directive,
      id: '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
      projectId: 'shop-branch-id',
    }));
    const server = await configured((api) => {
      const original = api.handle.bind(api);
      api.handle = (resource, request) =>
        resource === 'project-directives' && request.method === 'GET'
          ? Response.json({
              projectDirectives: items,
              page: {
                pageIndex: Number(request.query.pageIndex),
                pageSize: 100,
                total: request.query.pageIndex === '1' ? 201 : 200,
              },
            })
          : original(resource, request);
    });
    const result = await h.run('arch directives set -p shop --file directives.json');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('list changed while reading');
    expect(server.getRecordedRequests().filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it.each(['incomplete', 'wrong-project', 'missing-fields', 'duplicate-id'])(
    'refuses a %s public list before writing',
    async (kind) => {
      const item = {
        ...directive,
        id: '00000000-0000-4000-8000-000000000001',
        projectId: kind === 'wrong-project' ? 'another-project' : 'shop-branch-id',
      };
      const items =
        kind === 'missing-fields'
          ? [{}]
          : kind === 'incomplete'
            ? []
            : kind === 'duplicate-id'
              ? [item, item]
              : [item];
      const body = {
        projectDirectives: items,
        page: { pageIndex: 1, pageSize: 100, total: kind === 'incomplete' ? 1 : items.length },
      };
      const server = await configured((api) =>
        api.withStatus('project-directives', 200, JSON.stringify(body), 'GET'),
      );
      const result = await h.run('arch directives set -p shop --file directives.json');
      expect(result.exitCode).toBe(1);
      expect(server.getRecordedRequests().filter((r) => r.method === 'POST')).toHaveLength(0);
    },
  );
  it('does not copy server-owned fields and distinguishes an empty later page from an empty list', async () => {
    const server = await configured();
    h.cwd.writeFile(
      'directives.json',
      JSON.stringify({
        project: 'shop',
        create: [
          {
            ...directive,
            id: '00000000-0000-4000-8000-000000000999',
            projectId: 'shop-branch-id',
            origin: 'server-owned',
          },
        ],
      }),
    );
    const result = await h.run('arch directives set -p shop --file directives.json');
    expect(result.exitCode).toBe(0);
    const posts = server
      .getRecordedRequests()
      .filter((r) => r.method === 'POST' && r.path.includes('project-directives'));
    expect(posts).toHaveLength(1);
    const request = JSON.parse(posts[0].body!);
    expect(request).not.toHaveProperty('id');
    expect(request).not.toHaveProperty('origin');
    expect(request.projectId).toBe('shop-branch-id');
    const read = await h.run('arch directives get -p shop --page 2 --page-size 1 --format text');
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain('Page 2: 0 of 1 directives');
    expect(read.stdout).not.toContain('No directives are visible');
  });
});

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
  it('treats missing, null and default perspectives as one operation and sends the default on create', async () => {
    const server = await configured((api) =>
      api.withDirectives([
        {
          ...directive,
          graphPerspective: 'default_perspective',
          id: '00000000-0000-4000-8000-000000000001',
          projectId: 'shop-branch-id',
        },
      ]),
    );
    h.cwd.writeFile(
      'changes.json',
      JSON.stringify({
        create: [
          directive,
          { ...directive, graphPerspective: null },
          { ...directive, fromNodeKey: 'app:new' },
          { ...directive, fromNodeKey: 'app:new', graphPerspective: 'default_perspective' },
        ],
      }),
    );
    const result = await h.run('arch directives set -p shop --file changes.json');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Created 1 directives');
    expect(result.stdout).toContain('Skipped 3 existing');
    const posts = server
      .getRecordedRequests()
      .filter((r) => r.method === 'POST' && r.path.includes('project-directives'));
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body!).graphPerspective).toBe('default_perspective');
    expect(JSON.parse(posts[0].body!).origin).toBe('sonarqube-cli');
  });

  it.each([false, true])(
    'rejects a full project before writing even with duplicate identities or pending deletions (dryRun=%s)',
    async (dryRun) => {
      const rows = Array.from({ length: 1000 }, (_, i) => ({
        ...directive,
        id: '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
        projectId: 'shop-branch-id',
      }));
      const server = await configured((api) => api.withDirectives(rows));
      h.cwd.writeFile(
        'changes.json',
        JSON.stringify({
          create: [{ ...directive, fromNodeKey: 'app:new' }],
        }),
      );
      const result = await h.run(
        'arch directives set -p shop --file changes.json' + (dryRun ? ' --dry-run' : ''),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('limit of 1000 directives');
      expect(
        server.getRecordedRequests().filter((r) => ['POST', 'PATCH', 'DELETE'].includes(r.method)),
      ).toHaveLength(0);
      h.cwd.writeFile('changes.json', JSON.stringify({ create: [directive] }));
      expect((await h.run('arch directives set -p shop --file changes.json')).exitCode).toBe(0);
    },
  );

  it('creates up to the project capacity after skipping duplicates', async () => {
    const rows = Array.from({ length: 999 }, (_, i) => ({
      ...directive,
      id: '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
      projectId: 'shop-branch-id',
    }));
    const server = await configured((api) => api.withDirectives(rows));
    h.cwd.writeFile(
      'changes.json',
      JSON.stringify({ create: [directive, { ...directive, fromNodeKey: 'app:new' }] }),
    );
    expect((await h.run('arch directives set -p shop --file changes.json')).exitCode).toBe(0);
    expect(
      server
        .getRecordedRequests()
        .filter((r) => r.method === 'POST' && r.path.includes('project-directives')),
    ).toHaveLength(1);
  });

  it('omits untouched optional PATCH fields and preserves the origin from the fresh guard read', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const original = {
      ...directive,
      id,
      projectId: 'shop-branch-id',
      description: 'old',
      graphPerspective: 'old',
      origin: 'old-origin',
    };
    const server = await configured((api) => {
      api.withDirectives([original]);
      const handle = api.handle.bind(api);
      let reads = 0;
      api.handle = (resource, request) => {
        if (
          resource === 'project-directives' &&
          request.method === 'GET' &&
          request.modelId &&
          ++reads === 2
        )
          api.withDirectives([
            {
              ...original,
              description: 'concurrent',
              graphPerspective: 'concurrent',
              origin: 'fresh-origin',
            },
          ]);
        return handle(resource, request);
      };
    });
    h.cwd.writeFile('changes.json', JSON.stringify({ update: [{ id, fromNodeKey: 'app:new' }] }));
    const result = await h.run('arch directives set -p shop --file changes.json');
    expect(result.exitCode).toBe(0);
    const patch = JSON.parse(server.getRecordedRequests().find((r) => r.method === 'PATCH')!.body!);
    expect(patch).toEqual({ ...directive, fromNodeKey: 'app:new', origin: 'fresh-origin' });
    const read = await h.run(`arch directives get -p shop --id ${id} --format json`);
    expect(JSON.parse(read.stdout).directive).toMatchObject({
      description: 'concurrent',
      graphPerspective: 'concurrent',
      origin: 'fresh-origin',
    });
  });

  it('reads persisted long optional fields and leaves them omitted from an unrelated update', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const server = await configured((api) =>
      api.withDirectives([
        {
          ...directive,
          id,
          projectId: 'shop-branch-id',
          graphPerspective: 'p'.repeat(256),
          description: 'd'.repeat(10001),
        },
      ]),
    );
    h.cwd.writeFile('changes.json', JSON.stringify({ update: [{ id, toNodeKey: 'app:next' }] }));
    expect((await h.run('arch directives set -p shop --file changes.json')).exitCode).toBe(0);
    const patch = JSON.parse(server.getRecordedRequests().find((r) => r.method === 'PATCH')!.body!);
    expect(patch).not.toHaveProperty('description');
    expect(patch).not.toHaveProperty('graphPerspective');
  });

  it.each(['existing', 'batch', 'later-page'])(
    'refuses identity collisions before any write: %s',
    async (kind: string) => {
      const first = '00000000-0000-4000-8000-000000000001';
      const second = '00000000-0000-4000-8000-000000000002';
      const rows: ProjectDirective[] = [
        { ...directive, id: first, projectId: 'shop-branch-id' },
        { ...directive, id: second, projectId: 'shop-branch-id', fromNodeKey: 'app:other' },
      ];
      if (kind === 'later-page')
        rows.splice(
          1,
          0,
          ...Array.from({ length: 99 }, (_, i) => ({
            ...directive,
            id: `00000000-0000-4000-8000-${String(i + 3).padStart(12, '0')}`,
            projectId: 'shop-branch-id',
            fromNodeKey: `filler:${i}`,
          })),
        );
      const server = await h
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken('token')
        .withProject('shop', (p) => p.withArchitecture((a) => a.withDirectives(rows)))
        .start();
      h.withAuth(server.recordedAuthServerUrl(), 'token', 'my-org');
      const update =
        kind === 'batch'
          ? [
              { id: first, fromNodeKey: 'app:new' },
              { id: second, fromNodeKey: 'app:new' },
            ]
          : [{ id: first, fromNodeKey: 'app:other' }];
      for (const create of [[], [{ ...directive, fromNodeKey: 'new:source' }]]) {
        h.cwd.writeFile(
          'changes.json',
          JSON.stringify({
            create,
            update,
            ...(kind === 'pending-delete' ? { delete: [{ id: second }] } : {}),
          }),
        );
        for (const flag of ['', ' --dry-run']) {
          const result = await h.run(`arch directives set -p shop --file changes.json${flag}`);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain('An update would duplicate another directive');
        }
      }
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

  it('allows an update to a new directive identity after checking all existing identities', async () => {
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
    h.cwd.writeFile('changes.json', JSON.stringify({ update: [{ id, fromNodeKey: 'app:new' }] }));
    expect((await h.run('arch directives set -p shop --file changes.json')).exitCode).toBe(0);
    const read = await h.run(`arch directives get -p shop --id ${id} --format json`);
    expect(JSON.parse(read.stdout).directive.fromNodeKey).toBe('app:new');
  });

  it.each(['get', 'update'])(
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

  it.each([
    { operation: 'update', create: false },
    { operation: 'update', create: true },
  ])(
    'keeps a write-time missing directive as a definite rejection: %j',
    async ({ operation, create }) => {
      const id = '00000000-0000-4000-8000-000000000001';
      const server = await h
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken('token')
        .withProject('shop', (p) =>
          p.withArchitecture((a) =>
            a
              .withDirectives([{ ...directive, id, projectId: 'shop-branch-id' }])
              .withDirectiveReadFailure(2, 404),
          ),
        )
        .start();
      h.withAuth(server.recordedAuthServerUrl(), 'token', 'my-org');
      h.cwd.writeFile(
        'changes.json',
        JSON.stringify({
          create: create ? [{ ...directive, fromNodeKey: 'app:new' }] : [],
          [operation]: [{ id, ...(operation === 'update' ? { description: 'updated' } : {}) }],
        }),
      );
      const result = await h.run('arch directives set -p shop --file changes.json');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`Directive ${id} was not found`);
      expect(result.stderr).not.toContain('may already have been applied');
      expect(result.stderr).not.toContain('sonar list projects');
      if (create) {
        expect(result.stderr).toContain('stopped after 1 confirmed writes');
        expect(result.stderr).toContain('The server rejected the next directive');
      }
      expect(
        server.getRecordedRequests().filter((r) => ['PATCH', 'DELETE'].includes(r.method)),
      ).toHaveLength(0);
      expect(
        server
          .getRecordedRequests()
          .filter((r) => r.method === 'POST' && r.path.includes('project-directives')),
      ).toHaveLength(create ? 1 : 0);
    },
  );

  it('does not suggest another page for an empty project', async () => {
    await configured();
    const read = await h.run('arch directives get -p shop --format text');
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain('No directives are visible');
    expect(read.stdout).not.toContain('Use --page to continue');
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

  it('reads, previews and updates explicit ids without changing other directives', async () => {
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
    const updated = await h.run('arch directives get -p shop --format json');
    const records: ProjectDirective[] = JSON.parse(updated.stdout).directives;
    expect(records.find((record) => record.id === id)).toMatchObject({
      ...existing[0],
      description: 'updated',
    });
    expect(records.find((record) => record.id === other)).toMatchObject(existing[1]);
    const noop = await h.run('arch directives set -p shop --file updates.json');
    expect(noop.stdout).toMatch(/Skipped 1.*unchanged/);
    expect(server.getRecordedRequests().filter((r) => r.method === 'PATCH')).toHaveLength(1);
    expect(
      server.getRecordedRequests().filter((r) => r.path.includes('current-architectures')),
    ).toHaveLength(0);
    const patch = server.getRecordedRequests().find((r) => r.method === 'PATCH')!;
    expect(JSON.parse(patch.body!)).toEqual({
      ...directive,
      description: 'updated',
      origin: 'SONAR_CLI',
    });
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
    expect(
      server.getRecordedRequests().filter((r) => ['PATCH', 'DELETE'].includes(r.method)),
    ).toHaveLength(0);
  });

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
    const firstText = await h.run('arch directives get -p shop --format text --page-size 100');
    expect(firstText.stdout).toContain('Use --page to continue');
    const lastText = await h.run(
      'arch directives get -p shop --format text --page 2 --page-size 100',
    );
    expect(lastText.stdout).not.toContain('Use --page to continue');
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
    async (kind: string) => {
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

  it('refuses short pages before mutation even if later pages could make the declared total', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      ...directive,
      id: '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
      projectId: 'shop-branch-id',
    }));
    const server = await configured((api) => {
      const handle = api.handle.bind(api);
      api.handle = (resource, request) =>
        resource === 'project-directives' && request.method === 'GET'
          ? Response.json({
              projectDirectives:
                request.query.pageIndex === '1' ? rows.slice(0, 99) : rows.slice(99),
              page: { pageIndex: Number(request.query.pageIndex), pageSize: 100, total: 101 },
            })
          : handle(resource, request);
    });
    for (const flag of ['', ' --dry-run']) {
      const result = await h.run('arch directives set -p shop --file directives.json' + flag);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid public directives page');
    }
    expect(
      server.getRecordedRequests().filter((r) => ['POST', 'PATCH', 'DELETE'].includes(r.method)),
    ).toHaveLength(0);
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
    async (kind: string) => {
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
  it('sets CLI origin instead of copying exported fields and distinguishes an empty later page from an empty list', async () => {
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
    expect(request.origin).toBe('sonarqube-cli');
    expect(request.projectId).toBe('shop-branch-id');
    const read = await h.run('arch directives get -p shop --page 2 --page-size 1 --format text');
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain('Page 2: 0 of 1 directives');
    expect(read.stdout).not.toContain('No directives are visible');
    expect(read.stdout).not.toContain('Use --page to continue');
  });
  it('reads a stored directive by id and preserves its fields', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    await configured((api) =>
      api.withDirectives([{ ...directive, id, projectId: 'shop-branch-id' }]),
    );
    const result = await h.run(`arch directives get -p shop --id ${id} --format json`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).directive).toMatchObject({ ...directive, id });
  });

  it('rejects unsupported mutation phases before sending any write', async () => {
    const server = await configured();
    for (const operation of ['delete']) {
      h.cwd.writeFile('unsupported.json', JSON.stringify({ create: [directive], [operation]: [] }));
      const result = await h.run('arch directives set -p shop --file unsupported.json');
      expect(result.exitCode).not.toBe(0);
    }
    expect(
      server.getRecordedRequests().filter((r) => ['POST', 'PATCH', 'DELETE'].includes(r.method)),
    ).toHaveLength(0);
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
        api.withStatus('project-directives', 200, JSON.stringify(saved), 'GET'),
      );
      expect((await h.run(`arch directives get -p shop --id ${id}`)).exitCode).not.toBe(0);
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

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

// Integration tests for `sonar architecture get` on the public architecture API

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  type IntendedArchitecture,
  type StructureGraph,
} from '@/core/architecture/architecture-api.ts';
import { ALPHA_ENV_VAR } from '@/core/commands/stage.ts';

import { type FakeSonarQubeServer, TestHarness } from '../../harness';
import { type FakeArchitecture, fakeMainBranchId } from '../../harness/fake-architecture';
import type { ProjectBuilder } from '../../harness/fake-sonarqube-server';
import type { RecordedRequest } from '../../harness/types';
import { git, initGitRepo } from '../hook/git-test-helpers';

const TOKEN = 'arch-token';
const PROJECT = 'shop';

const GRAPH: StructureGraph[] = [
  {
    id: 'graph-shop',
    nodeCount: 3,
    edgeCount: 1,
    nodes: [
      {
        id: 1,
        name: 'app',
        kind: 'module',
        edges: [],
        nodes: [{ id: 2, name: 'com.shop.web', kind: 'package', edges: [{ toId: 3, weight: 4 }] }],
      },
      {
        id: 4,
        name: 'core',
        kind: 'module',
        edges: [],
        nodes: [{ id: 3, name: 'com.shop.domain', kind: 'package', edges: [] }],
      },
    ],
  },
];

const INTENDED: IntendedArchitecture[] = [
  {
    type: 'namespace',
    language: 'java',
    groups: [
      { label: 'Domain', patterns: ['core:com.shop.domain.**'] },
      { label: 'Web', patterns: ['app:**'] },
    ],
    constraints: [{ from: 'Web', to: 'Domain' }],
  },
];

describe('sonar architecture get on the public API', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.withExtraEnv({ [ALPHA_ENV_VAR]: 'true' });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function cloudServerWith(configure: (project: ProjectBuilder) => void) {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken(TOKEN)
      .withProject(PROJECT, configure)
      .start();
    harness.withAuth(server.recordedAuthServerUrl(), TOKEN, 'my-org');
    return server;
  }

  for (const command of [
    'arch get current --language java --format json',
    'arch get intended --format json',
    'arch set intended --file model.json --dry-run',
    'arch set intended --file model.json',
  ]) {
    it(`uses a key-only local configuration with the authenticated connection: ${command}`, async () => {
      const server = await cloudServerWith((project) =>
        project.withArchitecture((architecture) =>
          architecture.withStructure('java', GRAPH).withIntended(INTENDED),
        ),
      );
      initGitRepo(harness.cwd.path);
      git(
        ['remote', 'add', 'origin', 'https://github.com/example/repository.git'],
        harness.cwd.path,
      );
      harness.cwd.writeFile('sonar-project.properties', `sonar.projectKey=${PROJECT}\n`);
      harness.cwd.writeFile('model.json', JSON.stringify({ models: INTENDED }));

      const result = await harness.run(command);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(`Using auto-detected project key: ${PROJECT}`);
      const paths = server.getRecordedRequests().map(({ path }) => path);
      expect(paths.some((path) => path.startsWith('/architecture/'))).toBe(true);
      expect(paths.some((path) => path.includes('dop-translation'))).toBe(false);
      expect(paths).not.toContain('/api/components/search_projects');
      expect(paths).not.toContain('/api/navigation/component');
    });
  }

  it('never discovers an unconfigured project through a git remote, but accepts an explicit key', async () => {
    const server = await cloudServerWith((project) =>
      project.withArchitecture((architecture) => architecture.withStructure('java', GRAPH)),
    );
    initGitRepo(harness.cwd.path);
    git(['remote', 'add', 'origin', 'https://github.com/example/repository.git'], harness.cwd.path);

    const missing = await harness.run('arch get current --language java --format json');
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('Could not determine project key.');
    const explicit = await harness.run(
      `arch get current -p ${PROJECT} --language java --format json`,
    );
    expect(explicit.exitCode).toBe(0);
    expect(JSON.parse(explicit.stdout).project).toBe(PROJECT);
    const paths = server.getRecordedRequests().map(({ path }) => path);
    expect(paths.some((path) => path.includes('dop-translation'))).toBe(false);
    expect(paths).not.toContain('/api/components/search_projects');
    expect(paths).not.toContain('/api/navigation/component');
  });

  for (const explicitChildren of [false, true]) {
    it(`keeps intended leaf views and touching constraints with ${explicitChildren ? 'empty' : 'omitted'} children`, async () => {
      const constraints = [
        { from: 'Web', to: 'Domain/Billing' },
        { from: 'Domain/Billing', to: 'Web' },
      ];
      await cloudServerWith((project) =>
        project.withArchitecture((architecture) =>
          architecture.withIntended([
            {
              type: 'namespace',
              language: 'java',
              groups: [
                {
                  label: 'Domain',
                  groups: [
                    {
                      label: 'Billing',
                      patterns: ['billing:**'],
                      ...(explicitChildren ? { groups: [] } : {}),
                    },
                  ],
                },
                { label: 'Web', patterns: ['web:**'] },
              ],
              constraints,
            },
          ]),
        ),
      );
      const result = await harness.run(
        `arch get intended -p ${PROJECT} --component Domain/Billing --format json`,
      );
      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as { partial: boolean; models: unknown[] };
      expect(payload.partial).toBe(true);
      expect(payload.models).toEqual([
        {
          type: 'namespace',
          language: 'java',
          root: 'Domain/Billing',
          groups: [],
          constraints,
        },
      ]);
    });
  }

  it('drops unexpected nested intended fields and unsupported current graph ids', async () => {
    const hidden = 'synthetic-private-canary';
    const model = {
      ...INTENDED[0],
      id: '00000000-0000-4000-8000-000000000001',
      groups: [
        {
          label: 'A',
          patterns: [],
          privateField: hidden,
          groups: [{ label: 'B', privateField: hidden }],
        },
      ],
      constraints: [{ from: '*', to: '*', privateField: hidden }],
      privateField: hidden,
    };
    await cloudServerWith((p) =>
      p.withArchitecture((a) =>
        a
          .withStatus(
            'intended-architectures',
            200,
            JSON.stringify({ intendedArchitectures: [model] }),
            'GET',
          )
          .withStatus(
            'current-architectures',
            200,
            JSON.stringify({ currentArchitectures: [{ ...GRAPH[0], id: hidden }] }),
            'GET',
          ),
      ),
    );
    const intended = await harness.run(`arch get intended -p ${PROJECT} --format json`);
    const current = await harness.run(
      `arch get current -p ${PROJECT} --language java --format json`,
    );
    expect(intended.exitCode).toBe(0);
    expect(current.exitCode).toBe(0);
    expect(intended.stdout).not.toContain(hidden);
    expect(intended.stdout).not.toContain('privateField');
    expect(current.stdout).not.toContain(hidden);
    expect(current.stdout).not.toContain('graphId');
    expect(JSON.parse(intended.stdout).models[0].groups).toEqual([
      { label: 'A', patterns: [], groups: [{ label: 'B' }] },
    ]);
  });

  for (const malformed of [
    { type: { privateField: 'malformed-secret-canary' } },
    { language: { privateField: 'malformed-secret-canary' } },
    { groups: [{ label: { privateField: 'malformed-secret-canary' } }] },
    { groups: [{ label: 'A', patterns: [{ privateField: 'malformed-secret-canary' }] }] },
    { groups: [{ label: 'A', interface: { privateField: 'malformed-secret-canary' } }] },
    { constraints: [{ from: { privateField: 'malformed-secret-canary' }, to: '*' }] },
  ]) {
    it(`rejects malformed known public properties without echoing their contents: ${Object.keys(malformed).join()}`, async () => {
      await cloudServerWith((p) =>
        p.withArchitecture((a) =>
          a.withStatus(
            'intended-architectures',
            200,
            JSON.stringify({
              intendedArchitectures: [
                { ...INTENDED[0], id: '00000000-0000-4000-8000-000000000001', ...malformed },
              ],
            }),
            'GET',
          ),
        ),
      );
      const result = await harness.run(`arch get intended -p ${PROJECT} --format json`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid public intended architecture response');
      expect(result.stdout + result.stderr).not.toContain('malformed-secret-canary');
      expect(result.stdout).toBe('');
    });
  }

  for (const malformed of [
    { name: { privateField: 'malformed-secret-canary' } },
    { kind: { privateField: 'malformed-secret-canary' } },
    { separator: { privateField: 'malformed-secret-canary' } },
    { edges: [{ toId: 3, weight: { privateField: 'malformed-secret-canary' } }] },
  ]) {
    it(`rejects malformed current node fields without echoing contents: ${Object.keys(malformed).join()}`, async () => {
      const graph = {
        nodeCount: 1,
        edgeCount: 0,
        nodes: [{ id: 1, name: 'safe', kind: 'module', edges: [], ...malformed }],
      };
      await cloudServerWith((p) =>
        p.withArchitecture((a) =>
          a.withStatus(
            'current-architectures',
            200,
            JSON.stringify({ currentArchitectures: [graph] }),
            'GET',
          ),
        ),
      );
      const result = await harness.run(
        `arch get current -p ${PROJECT} --language java --format json`,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid public current architecture response');
      expect(result.stdout + result.stderr).not.toContain('malformed-secret-canary');
      expect(result.stdout).toBe('');
    });
  }

  it(
    'reads /current-architectures and /intended-architectures on Cloud with the same ids',
    async () => {
      const server = await cloudServerWith((p) =>
        p.withArchitecture((a) => a.withStructure('java', GRAPH).withIntended(INTENDED)),
      );

      const current = await harness.run(
        `architecture get current --project ${PROJECT} --language java --format json`,
      );
      const intended = await harness.run(
        `architecture get intended --project ${PROJECT} --format json`,
      );

      expect(current.exitCode).toBe(0);
      expect(intended.exitCode).toBe(0);
      const requests = server.getRecordedRequests();
      const paths = requests.map(({ path }) => path);
      expect(paths).not.toContain('/architecture/structure');
      expect(paths).not.toContain('/architecture/intended');
      const currentCall = requests.find(
        ({ path }) => path === '/architecture/current-architectures',
      );
      expect(currentCall?.query).toEqual({
        organizationId: 'my-org-uuid-v4',
        branchId: fakeMainBranchId(PROJECT),
        ecosystem: 'java',
      });
      const intendedCall = requests.find(
        ({ path }) => path === '/architecture/intended-architectures',
      );
      expect(intendedCall?.query).toEqual({ projectId: fakeMainBranchId(PROJECT) });
      expect((JSON.parse(intended.stdout) as { models: unknown }).models).toEqual(INTENDED);
    },
    { timeout: 15000 },
  );

  it('shows every nonempty idless public graph and can drill into a later graph', async () => {
    const first: StructureGraph = {
      nodeCount: 1,
      edgeCount: 0,
      nodes: [{ id: 1, name: 'first', kind: 'module', edges: [] }],
    };
    const later: StructureGraph = {
      nodeCount: 2,
      edgeCount: 0,
      nodes: [
        {
          id: 1,
          name: 'later',
          kind: 'module',
          edges: [],
          nodes: [{ id: 2, name: 'example', kind: 'package', edges: [] }],
        },
      ],
    };
    await cloudServerWith((p) =>
      p.withArchitecture((a) => a.withStructure('java', [first, later])),
    );
    const all = await harness.run(`arch get current -p ${PROJECT} --language java --format json`);
    expect(all.exitCode).toBe(0);
    const payload = JSON.parse(all.stdout) as {
      languages: Array<{ language: string; graphId?: string; nodes: Array<{ key: string }> }>;
    };
    expect(payload.languages.map((view) => view.nodes.map((node) => node.key))).toEqual([
      ['first'],
      ['later'],
    ]);
    expect(payload.languages.every((view) => view.graphId === undefined)).toBe(true);
    const drill = await harness.run(
      `arch get current -p ${PROJECT} --language java --component later --format json`,
    );
    expect(drill.exitCode).toBe(0);
    const focused = JSON.parse(drill.stdout) as {
      languages: Array<{ root: string; nodes: Array<{ key: string }> }>;
    };
    expect(focused.languages).toHaveLength(1);
    expect(focused.languages[0].root).toBe('later');
    expect(focused.languages[0].nodes.map((node) => node.key)).toEqual(['later:example']);
  });

  it('shares the total node cap across multiple idless graphs of one language', async () => {
    const graphs: StructureGraph[] = [0, 1].map((graph) => ({
      nodeCount: 100,
      edgeCount: 0,
      nodes: Array.from({ length: 100 }, (_, node) => ({
        id: node,
        name: `graph${graph}-node${node}`,
        kind: 'module',
        edges: [],
      })),
    }));
    await cloudServerWith((p) => p.withArchitecture((a) => a.withStructure('java', graphs)));
    const result = await harness.run(
      `arch get current -p ${PROJECT} --language java --format json`,
    );
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      languages: Array<{ nodes: unknown[]; capped: boolean }>;
    };
    expect(payload.languages).toHaveLength(2);
    expect(payload.languages.map((view) => view.nodes.length)).toEqual([75, 75]);
    expect(payload.languages.every((view) => view.capped)).toBe(true);
  });

  it('does not exceed the node cap when there are more graphs than the budget', async () => {
    const graphs: StructureGraph[] = Array.from({ length: 40 }, (_, graph) => ({
      nodeCount: 1,
      edgeCount: 0,
      nodes: [{ id: 1, name: `module${graph}`, kind: 'module', edges: [] }],
    }));
    await cloudServerWith((p) =>
      p.withArchitecture((a) =>
        a
          .withStructure('java', graphs)
          .withStructure('cs', graphs)
          .withStructure('js', graphs)
          .withStructure('ts', graphs)
          .withStructure('py', graphs),
      ),
    );
    const result = await harness.run(`arch get current -p ${PROJECT} --format json`);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      languages: Array<{ nodes: unknown[]; capped: boolean }>;
    };
    expect(payload.languages).toHaveLength(200);
    expect(payload.languages.reduce((total, view) => total + view.nodes.length, 0)).toBe(150);
    expect(
      payload.languages.slice(150).every((view) => view.capped && view.nodes.length === 0),
    ).toBe(true);
  });

  it('fails Server intended discovery without private requests, while current remains available', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken(TOKEN)
      .withProject(PROJECT, (p) => p.withArchitecture((a) => a.withStructure('java', GRAPH)))
      .start();
    harness.withAuth(server.baseUrl(), TOKEN);
    const current = await harness.run(
      `architecture get current --project ${PROJECT} --language java --format json`,
    );
    expect(current.exitCode).toBe(0);
    expect(JSON.parse(current.stdout).languages[0]).not.toHaveProperty('graphId');
    const before = server.getRecordedRequests().length;
    const intended = await harness.run(
      `architecture get intended --project ${PROJECT} --format json`,
    );
    expect(intended.exitCode).toBe(1);
    expect(intended.stderr).toContain('confirmed public endpoint');
    expect(
      server
        .getRecordedRequests()
        .slice(before)
        .filter(
          ({ path }) =>
            path.includes('/architecture/') ||
            path.includes('search_projects') ||
            path.includes('/navigation/'),
        ),
    ).toEqual([]);
  });

  for (const [status, body] of [
    [404, '{"message":"Not deployed"}'],
    [200, '{}'],
  ] as const) {
    it(`surfaces a missing or malformed current public API (${status}) without fallback`, async () => {
      const server = await cloudServerWith((p) =>
        p.withArchitecture((a) => a.withStatus('current-architectures', status, body)),
      );
      const result = await harness.run(
        `architecture get current --project ${PROJECT} --language java --format json`,
      );
      expect(result.exitCode).toBe(1);
      const paths = server
        .getRecordedRequests()
        .filter(({ path }) => path.startsWith('/architecture/'))
        .map(({ path }) => path);
      expect(paths).toEqual(['/architecture/current-architectures']);
      expect(result.stderr).not.toContain('No current architecture yet');
    });
  }

  it(
    'explains the 403 the public API answers to a caller who may not read the project',
    async () => {
      await cloudServerWith((p) =>
        p.withArchitecture((a) =>
          a.withStatus(
            'current-architectures',
            403,
            JSON.stringify({
              message: 'You are not authorized to view the structure graph for this project.',
            }),
          ),
        ),
      );

      const result = await harness.run(`architecture get current --project ${PROJECT}`, {});

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `The Architecture API refused access to '${PROJECT}' (HTTP 403).`,
      );
    },
    { timeout: 15000 },
  );
});

const NEXT: IntendedArchitecture[] = [
  {
    type: 'namespace',
    language: 'java',
    groups: [
      { label: 'Domain', patterns: ['core:com.shop.domain.**'], interface: true },
      { label: 'Web', patterns: ['app:**'] },
      { label: 'Billing', patterns: ['billing:**'] },
    ],
    constraints: [
      { from: 'Web', to: 'Domain' },
      { from: 'Billing', to: 'Domain' },
    ],
  },
];

const PUBLIC_PATH = '/architecture/intended-architectures';

function writes(server: FakeSonarQubeServer): RecordedRequest[] {
  return server
    .getRecordedRequests()
    .filter(({ path, method }) => path.startsWith('/architecture/') && method !== 'GET');
}

function described(requests: RecordedRequest[]): string[] {
  return requests.map(({ method, path, query }) =>
    [method, path, new URLSearchParams(query).toString()].filter(Boolean).join(' '),
  );
}

describe('sonar architecture set on the public API', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.withExtraEnv({ [ALPHA_ENV_VAR]: 'true' });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function startWith(configure: (fake: FakeArchitecture) => void) {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken(TOKEN)
      .withProject(PROJECT, (p) => p.withArchitecture(configure))
      .start();
    harness.withAuth(server.recordedAuthServerUrl(), TOKEN, 'my-org');
    return server;
  }

  async function setIntended(file: unknown) {
    harness.cwd.writeFile('model.json', JSON.stringify(file));
    return harness.run(`architecture set intended --project ${PROJECT} --file model.json`, {
      extraEnv: {},
    });
  }

  async function readSavedFile(): Promise<{ revision: string; models: IntendedArchitecture[] }> {
    const result = await harness.run(
      `architecture get intended --project ${PROJECT} --format json`,
    );
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as { revision: string; models: IntendedArchitecture[] };
  }

  it(
    'creates through POST /intended-architectures with one perspective and no client id',
    async () => {
      const server = await startWith(() => undefined);

      const result = await setIntended({ models: NEXT });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Created the intended architecture of '${PROJECT}'.`);
      const calls = writes(server);
      expect(described(calls)).toEqual([
        `POST ${PUBLIC_PATH} projectId=${fakeMainBranchId(PROJECT)}`,
      ]);
      expect(JSON.parse(calls[0].body ?? '{}')).toEqual(NEXT[0]);
      expect((await readSavedFile()).models).toEqual(NEXT);
    },
    { timeout: 15000 },
  );

  it('previews and saves distinct constraint pairs whose display text used to collide', async () => {
    const groups = ['A', 'A -> B', 'B -> C', 'C'].map((label) => ({ label, patterns: [] }));
    const before: IntendedArchitecture[] = [
      {
        type: 'namespace',
        language: 'java',
        groups,
        constraints: [
          { from: 'A -> B', to: 'C' },
          { from: 'C', to: 'A' },
        ],
      },
    ];
    const server = await startWith((architecture) => architecture.withIntended(before));
    const saved = await readSavedFile();
    const next = [
      {
        ...before[0],
        constraints: [
          { from: 'A', to: 'B -> C' },
          { from: 'C', to: 'A' },
        ],
      },
    ];
    const file = { ...saved, models: next };
    harness.cwd.writeFile('model.json', JSON.stringify(file));
    const preview = await harness.run(
      `arch set intended -p ${PROJECT} --file model.json --dry-run`,
    );
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('1 removed, 1 added, 0 changed.');
    expect(preview.stdout).toContain('"A -> B" -> C');
    expect(preview.stdout).toContain('A -> "B -> C"');
    expect(writes(server)).toEqual([]);
    const result = await setIntended(file);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Replaced the intended architecture of '${PROJECT}'.`);
    expect(writes(server).map(({ method }) => method)).toEqual(['DELETE', 'POST']);
    expect((await readSavedFile()).models).toEqual(next);
  });

  it('replaces through only allowlisted public architecture endpoints and warns about flattened imports', async () => {
    const server = await startWith((fake) =>
      fake.withSavedPerspectives([
        {
          qualifiers: 'namespace',
          language: 'java',
          groups: [{ label: 'Shared', patterns: ['lib:**'], patternId: 'shared' }],
          constraints: [],
        },
      ]),
    );
    const saved = await readSavedFile();
    harness.cwd.writeFile('model.json', JSON.stringify({ ...saved, models: NEXT }));
    const dry = await harness.run(
      `architecture set intended --project ${PROJECT} --file model.json --dry-run`,
    );
    expect(dry.exitCode).toBe(0);
    expect(dry.stderr).toContain('may flatten those imports');
    expect(writes(server)).toEqual([]);
    const result = await setIntended({ ...saved, models: NEXT });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('may flatten those imports');
    for (const { method, path } of server
      .getRecordedRequests()
      .filter(({ path }) => path.startsWith('/architecture/'))) {
      expect([
        'GET /architecture/current-architectures',
        'GET /architecture/intended-architectures',
        'POST /architecture/intended-architectures',
        'DELETE /architecture/intended-architectures/00000000-0000-4000-8000-000000000001',
      ]).toContain(`${method} ${path}`);
    }
    expect((await readSavedFile()).models).toEqual(NEXT);
  });

  for (const committed of [false, true]) {
    it(`reconciles a failed DELETE response without data loss (committed=${committed})`, async () => {
      const server = await startWith((fake) =>
        fake.withIntended(INTENDED).failModelDelete(1, committed),
      );
      const result = await setIntended({ ...(await readSavedFile()), models: NEXT });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('previous export was preserved or restored');
      expect((await readSavedFile()).models).toEqual(INTENDED);
      expect(writes(server).filter(({ method }) => method === 'POST')).toHaveLength(
        committed ? 1 : 0,
      );
    });
  }

  it('does not overwrite concurrent changes while reconciling a failed DELETE', async () => {
    const server = await startWith((fake) =>
      fake.withIntended(INTENDED).failModelDelete(1, true).changeIntendedBeforeRead(4, NEXT),
    );
    const result = await setIntended({ ...(await readSavedFile()), models: NEXT });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('automatic recovery could not be completed');
    expect(writes(server).filter(({ method }) => method === 'POST')).toEqual([]);
    expect((await readSavedFile()).models).toEqual(NEXT);
  });

  it('clears with DELETE only and allows a new model to be created afterward', async () => {
    const server = await startWith((fake) => fake.withIntended(INTENDED));
    const cleared = await setIntended({ ...(await readSavedFile()), models: [] });
    expect(cleared.exitCode).toBe(0);
    expect(writes(server).map(({ method }) => method)).toEqual(['DELETE']);
    expect((await readSavedFile()).models).toEqual([]);
    const recreated = await setIntended({ models: NEXT });
    expect(recreated.exitCode).toBe(0);
    expect(writes(server).map(({ method }) => method)).toEqual(['DELETE', 'POST']);
    expect((await readSavedFile()).models).toEqual(NEXT);
  });

  it('confirms an initial POST that committed before its response failed', async () => {
    const server = await startWith((fake) => fake.failCommittedIntendedCreate(1));
    const result = await setIntended({ models: NEXT });
    expect(result.exitCode).toBe(0);
    expect(writes(server).map(({ method }) => method)).toEqual(['POST']);
    expect((await readSavedFile()).models).toEqual(NEXT);
  });

  it('confirms an ambiguous POST through public GET without a duplicate or rollback', async () => {
    const server = await startWith((fake) =>
      fake.withIntended(INTENDED).failCommittedIntendedCreate(1),
    );
    const result = await setIntended({ ...(await readSavedFile()), models: NEXT });
    expect(result.exitCode).toBe(0);
    expect(writes(server).filter(({ method }) => method === 'POST')).toHaveLength(1);
    expect((await readSavedFile()).models).toEqual(NEXT);
  });

  it(
    'restores the previous model through the public POST when the new one is refused',
    async () => {
      const server = await startWith((fake) => fake.withIntended(INTENDED).failModelCreates(400));
      const saved = await readSavedFile();

      const result = await setIntended({ ...saved, models: NEXT });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'Saving the new intended architecture failed; the previous export was preserved or restored. Model rejected (400)',
      );
      expect(described(writes(server))).toEqual([
        `DELETE ${PUBLIC_PATH}/00000000-0000-4000-8000-000000000001`,
        `POST ${PUBLIC_PATH} projectId=${fakeMainBranchId(PROJECT)}`,
        `POST ${PUBLIC_PATH} projectId=${fakeMainBranchId(PROJECT)}`,
      ]);
      expect((await readSavedFile()).models).toEqual(INTENDED);
    },
    { timeout: 15000 },
  );

  it('stops after one DELETE when an unbacked legacy model becomes visible', async () => {
    const server = await startWith((fake) =>
      fake.withIntended(INTENDED).withAdditionalIntended(NEXT),
    );
    const result = await setIntended({ ...(await readSavedFile()), models: NEXT });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('automatic recovery could not be completed');
    expect(writes(server).map(({ method }) => method)).toEqual(['DELETE']);
  });

  for (const body of ['{}', '{"intendedArchitectures":null}']) {
    it(`rejects a malformed public export before any writes: ${body}`, async () => {
      const server = await startWith((fake) =>
        fake.withStatus('intended-architectures', 200, body, 'GET'),
      );
      const result = await setIntended({ models: NEXT });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('intendedArchitectures must be an array');
      expect(writes(server)).toEqual([]);
    });
  }

  it('refuses a proposed multi-perspective model before dry run or any mutation', async () => {
    const server = await startWith(() => undefined);
    harness.cwd.writeFile(
      'model.json',
      JSON.stringify({ models: [NEXT[0], { ...NEXT[0], language: 'ts' }] }),
    );
    for (const suffix of [' --dry-run', '']) {
      const result = await harness.run(
        `architecture set intended --project ${PROJECT} --file model.json${suffix}`,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('cannot be safely applied or restored');
    }
    expect(writes(server)).toEqual([]);
  });

  it('rejects a public export without a server id before any mutation', async () => {
    const server = await startWith((fake) =>
      fake.withStatus(
        'intended-architectures',
        200,
        JSON.stringify({ intendedArchitectures: INTENDED }),
        'GET',
      ),
    );
    const result = await setIntended({ models: NEXT });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('expected one stored model with a server id');
    expect(writes(server)).toEqual([]);
  });

  it('keeps server ids out of exports and preserves content revisions after replacement', async () => {
    const server = await startWith((fake) => fake.withIntended(INTENDED));
    const before = await readSavedFile();
    expect(before.models[0]).not.toHaveProperty('id');
    expect((await setIntended({ ...before, models: NEXT })).exitCode).toBe(0);
    const next = await readSavedFile();
    expect((await setIntended({ ...next, models: INTENDED })).exitCode).toBe(0);
    expect((await readSavedFile()).revision).toBe(before.revision);
    expect(
      writes(server)
        .filter(({ method }) => method === 'DELETE')
        .map(({ path, query }) => ({ path, query })),
    ).toEqual([
      { path: `${PUBLIC_PATH}/00000000-0000-4000-8000-000000000001`, query: {} },
      { path: `${PUBLIC_PATH}/00000000-0000-4000-8000-000000000002`, query: {} },
    ]);
  });

  it('never deletes a concurrent same-content replacement with a different server id', async () => {
    const server = await startWith((fake) =>
      fake.withIntended(INTENDED).changeIntendedBeforeRead(3, INTENDED),
    );
    const before = await readSavedFile();
    const result = await setIntended({ ...before, models: NEXT });
    expect(result.exitCode).toBe(1);
    expect(writes(server).map(({ method, path }) => `${method} ${path}`)).toEqual([
      `DELETE ${PUBLIC_PATH}/00000000-0000-4000-8000-000000000001`,
    ]);
    expect((await readSavedFile()).models).toEqual(INTENDED);
  });

  it('does not claim creation succeeded when the public response contains only an id', async () => {
    const server = await startWith((fake) =>
      fake.withStatus(
        'intended-architectures',
        201,
        JSON.stringify({ id: '00000000-0000-4000-8000-000000000001' }),
        'POST',
      ),
    );
    const result = await setIntended({ models: NEXT });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('returned content does not match the requested model');
    expect(writes(server).map(({ method }) => method)).toEqual(['POST']);
    expect((await readSavedFile()).models).toEqual([]);
  });

  it('rejects a malformed server model UUID before any mutation', async () => {
    const server = await startWith((fake) =>
      fake.withStatus(
        'intended-architectures',
        200,
        JSON.stringify({ intendedArchitectures: [{ ...INTENDED[0], id: 'invalid-id' }] }),
        'GET',
      ),
    );
    const result = await setIntended({ models: NEXT });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('expected one stored model with a server id');
    expect(writes(server)).toEqual([]);
  });

  it('does not register unsupported architecture commands', async () => {
    const server = await startWith(() => undefined);
    for (const command of [
      'architecture get directives',
      'architecture set directives --file missing.json --dry-run',
      'architecture set directives --file missing.json',
    ]) {
      const result = await harness.run(command);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("unknown command 'directives'");
      expect(result.stderr).not.toContain('auth login');
      expect(result.stderr).not.toContain('Cannot read');
    }
    for (const command of [
      'architecture --help',
      'architecture get --help',
      'architecture set --help',
    ]) {
      const help = await harness.run(command);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).not.toContain('directives');
    }
    expect(server.getRecordedRequests()).toEqual([]);
  });
});

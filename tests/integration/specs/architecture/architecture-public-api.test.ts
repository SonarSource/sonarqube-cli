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

import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  type IntendedArchitecture,
  type StructureGraph,
} from '@/core/architecture/architecture-api.ts';
import { shellQuote } from '@/core/architecture/shell-quote.ts';
import { ALPHA_ENV_VAR } from '@/core/commands/stage.ts';

import { type FakeSonarQubeServer, TestHarness } from '../../harness';
import {
  type FakeArchitecture,
  fakeMainBranchId,
  routeArchitectureRequest,
} from '../../harness/fake-architecture';
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
    expect(missing.stderr).toContain('Use --project <key>');
    expect(missing.stderr).toContain('run from inside a linked project directory');
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
      expect((JSON.parse(intended.stdout) as { models: unknown }).models).toEqual(
        publicModels(INTENDED),
      );
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
  async function setFile(file: unknown, suffix = '') {
    harness.cwd.writeFile('model.json', JSON.stringify(file));
    return harness.run(`architecture set intended --project ${PROJECT} --file model.json${suffix}`);
  }
  async function readSaved() {
    const result = await harness.run(
      `architecture get intended --project ${PROJECT} --format json`,
    );
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as { revision: string; models: IntendedArchitecture[] };
  }
  function backupFrom(stderr: string) {
    const path = /The previous export is saved in ([^\r\n]+\.json)/.exec(stderr)?.[1];
    expect(path).toBeDefined();
    expect(JSON.parse(readFileSync(path!, 'utf8'))).toEqual({
      project: PROJECT,
      models: publicModels(INTENDED),
    });
    return path!;
  }
  const TS_MODEL: IntendedArchitecture = { ...NEXT[0], type: 'file', language: 'ts' };
  const JAVA_FILE: IntendedArchitecture = { ...NEXT[0], type: 'file' };
  it('isolates a scoped three-perspective PATCH from another project with its own model', async () => {
    const cs: IntendedArchitecture = {
      ...NEXT[0],
      language: 'cs',
      groups: [{ label: 'CsDomain', patterns: ['cs:**'] }],
    };
    const javaFile: IntendedArchitecture = {
      ...JAVA_FILE,
      groups: [{ label: 'FileDomain', patterns: ['src/**'] }],
    };
    const original = [INTENDED[0], cs, javaFile];
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken(TOKEN)
      .withProject(PROJECT, (project) =>
        project.withArchitecture((fake) => fake.withIntended(INTENDED)),
      )
      .withProject('multi-shop', (project) =>
        project.withArchitecture((fake) => fake.withIntended(original)),
      )
      .start();
    harness.withAuth(server.recordedAuthServerUrl(), TOKEN, 'my-org');
    const exported = await harness.run(
      'arch get intended -p multi-shop --language java --format json',
    );
    expect(exported.exitCode).toBe(0);
    const file = JSON.parse(exported.stdout) as {
      revision: string;
      language: string;
      models: IntendedArchitecture[];
    };
    file.models
      .find(({ type }) => type === 'namespace')!
      .groups.push({ label: 'ScopedLayer', patterns: ['scoped:**'] });
    harness.cwd.writeFile('multi-scoped.json', JSON.stringify(file));
    const preview = await harness.run(
      'arch set intended -p multi-shop --file multi-scoped.json --dry-run',
    );
    expect(preview.exitCode).toBe(0);
    expect(writes(server)).toEqual([]);
    const applied = await harness.run('arch set intended -p multi-shop --file multi-scoped.json');
    const actual = await harness.run('arch get intended -p multi-shop --format json');
    const saved = JSON.parse(actual.stdout) as { models: IntendedArchitecture[] };
    expect(saved.models).toEqual(publicModels([cs, ...file.models]));
    expect(applied.exitCode).toBe(0);
    expect((await readSaved()).models).toEqual(publicModels(INTENDED));
    expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
    expect(JSON.parse(writes(server)[0].body!)).toEqual({
      intendedArchitectures: [
        ...publicModels([cs]),
        ...file.models.map((model) => ({
          ...model,
          groups: model.groups.map(({ groups: _groups, ...group }) => group),
        })),
      ],
    });
  });

  it('keeps lazily-created model UUIDs distinct from another project', async () => {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken(TOKEN)
      .withProject(PROJECT, (project) =>
        project.withArchitecture((fake) => fake.withIntended(INTENDED)),
      )
      .withProject('lazy-shop')
      .start();
    harness.withAuth(server.recordedAuthServerUrl(), TOKEN, 'my-org');
    harness.cwd.writeFile('create-lazy.json', JSON.stringify({ models: INTENDED }));
    expect(
      (await harness.run('arch set intended -p lazy-shop --file create-lazy.json')).exitCode,
    ).toBe(0);
    const exported = await harness.run('arch get intended -p lazy-shop --format json');
    const file = JSON.parse(exported.stdout) as {
      revision: string;
      models: IntendedArchitecture[];
    };
    harness.cwd.writeFile('update-lazy.json', JSON.stringify({ ...file, models: NEXT }));
    expect(
      (await harness.run('arch set intended -p lazy-shop --file update-lazy.json')).exitCode,
    ).toBe(0);
    const saved = await harness.run('arch get intended -p lazy-shop --format json');
    expect((JSON.parse(saved.stdout) as { models: IntendedArchitecture[] }).models).toEqual(
      publicModels(NEXT),
    );
    expect((await readSaved()).models).toEqual(publicModels(INTENDED));
    expect(writes(server).map(({ method }) => method)).toEqual(['POST', 'PATCH']);
  });

  for (const models of [NEXT, [...NEXT, TS_MODEL, JAVA_FILE]]) {
    it(`POSTs a full ${models.length}-perspective envelope with projectId in JSON`, async () => {
      const server = await startWith(() => undefined);
      const result = await setFile({ models });
      expect(result.exitCode).toBe(0);
      expect(writes(server)).toHaveLength(1);
      const [call] = writes(server);
      expect(call.method).toBe('POST');
      expect(call.path).toBe(PUBLIC_PATH);
      expect(call.query).toEqual({});
      expect(call.headers['content-type']).toBe('application/json');
      expect(JSON.parse(call.body!)).toEqual({
        projectId: fakeMainBranchId(PROJECT),
        intendedArchitectures: models,
      });
      expect((await readSaved()).models).toEqual(publicModels(models));
    });
  }
  it('PATCHes the complete perspectives with merge-patch content type and preserves the UUID', async () => {
    const original = [...INTENDED, TS_MODEL, JAVA_FILE];
    const desired = [...NEXT, TS_MODEL, JAVA_FILE];
    const server = await startWith((fake) => fake.withIntended(original));
    const saved = await readSaved();
    expect((await setFile({ ...saved, models: desired })).exitCode).toBe(0);
    const [call] = writes(server);
    expect(writes(server)).toHaveLength(1);
    expect(call.method).toBe('PATCH');
    expect(call.path).toBe(`${PUBLIC_PATH}/00000000-0000-4000-8000-000000000001`);
    expect(call.query).toEqual({});
    expect(call.headers['content-type']).toBe('application/merge-patch+json');
    expect(JSON.parse(call.body!)).toEqual({ intendedArchitectures: desired });
    expect((await readSaved()).models).toEqual(publicModels(desired));
  });
  it('preserves other perspectives when changing the second qualifier of one language', async () => {
    const server = await startWith((fake) => fake.withIntended([...INTENDED, JAVA_FILE]));
    const desiredFile = { ...JAVA_FILE, groups: [{ label: 'Changed', patterns: [] }] };
    const saved = await readSaved();
    const preview = await setFile({ ...saved, models: [...INTENDED, desiredFile] }, ' --dry-run');
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain('Changed');
    expect(writes(server)).toEqual([]);
    expect((await setFile({ ...saved, models: [...INTENDED, desiredFile] })).exitCode).toBe(0);
    expect((await readSaved()).models).toEqual(publicModels([...INTENDED, desiredFile]));
    expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
  });
  for (const committed of [false, true]) {
    it(`reconciles failed PATCH without rollback (committed=${committed})`, async () => {
      const server = await startWith((fake) =>
        fake.withIntended(INTENDED).failModelUpdate(1, committed),
      );
      const result = await setFile({ ...(await readSaved()), models: NEXT });
      expect(result.exitCode).toBe(committed ? 0 : 1);
      expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
      expect((await readSaved()).models).toEqual(publicModels(committed ? NEXT : INTENDED));
      if (!committed) {
        backupFrom(result.stderr);
        expect(result.stderr).toContain('No automatic rollback was attempted');
      }
    });
  }
  it('retains one permission hint and one backup instruction on PATCH 403', async () => {
    const server = await startWith((fake) =>
      fake.withIntended(INTENDED).failModelUpdate(1, false, 403),
    );
    const result = await setFile({ ...(await readSaved()), models: NEXT });
    expect(result.exitCode).toBe(1);
    const backup = backupFrom(result.stderr);
    expect(result.stderr.match(/Administer Architecture permission/g)).toHaveLength(1);
    expect(result.stderr.match(/The previous export is saved in/g)).toHaveLength(1);
    expect(result.stderr.match(/restore it with:/g)).toHaveLength(1);
    expect(result.stderr).toContain(`--file ${shellQuote(backup)}`);
    expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
    expect((await readSaved()).models).toEqual(publicModels(INTENDED));
  });
  it('preserves concurrent state after a rejected PATCH and never restores automatically', async () => {
    const concurrent = [{ ...NEXT[0], groups: [{ label: 'Concurrent', patterns: [] }] }];
    const server = await startWith((fake) =>
      fake.withIntended(INTENDED).failModelUpdate(1).changeIntendedBeforeRead(4, concurrent),
    );
    const result = await setFile({ ...(await readSaved()), models: NEXT });
    expect(result.exitCode).toBe(1);
    backupFrom(result.stderr);
    expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
    expect((await readSaved()).models).toEqual(publicModels(concurrent));
  });
  it('reports unknown server state and retains backup when PATCH verification cannot be read', async () => {
    const server = await startWith((fake) =>
      fake
        .withIntended(INTENDED)
        .failModelUpdate(1)
        .failIntendedRead(4)
        .failIntendedRead(5)
        .failIntendedRead(6)
        .failIntendedRead(7),
    );
    const result = await setFile({ ...(await readSaved()), models: NEXT });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('server state is unknown');
    backupFrom(result.stderr);
    expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
    expect((await readSaved()).models).toEqual(publicModels(INTENDED));
  });
  for (const models of [NEXT, INTENDED]) {
    it(`refuses preflight recreation even if content is ${models === INTENDED ? 'identical' : 'changed'}`, async () => {
      const server = await startWith((fake) =>
        fake.withIntended(INTENDED).changeIntendedBeforeRead(3, models),
      );
      const result = await setFile({ ...(await readSaved()), models: NEXT });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('identity changed');
      expect(writes(server)).toEqual([]);
      expect((await readSaved()).models).toEqual(publicModels(models));
    });
  }
  for (const committed of [false, true]) {
    it(`clears via DELETE only and reconciles response failure (committed=${committed})`, async () => {
      const server = await startWith((fake) =>
        fake.withIntended(INTENDED).failModelDelete(1, committed),
      );
      const result = await setFile({ ...(await readSaved()), models: [] });
      expect(result.exitCode).toBe(committed ? 0 : 1);
      expect(writes(server).map(({ method }) => method)).toEqual(['DELETE']);
      expect((await readSaved()).models).toEqual(publicModels(committed ? [] : INTENDED));
      if (!committed) backupFrom(result.stderr);
    });
  }
  it('clears the resource with DELETE, then creates a new model through POST', async () => {
    const server = await startWith((fake) => fake.withIntended(INTENDED));
    expect((await setFile({ ...(await readSaved()), models: [] })).exitCode).toBe(0);
    expect((await readSaved()).models).toEqual([]);
    expect(writes(server).map(({ method }) => method)).toEqual(['DELETE']);
    expect((await setFile({ models: NEXT })).exitCode).toBe(0);
    expect(writes(server).map(({ method }) => method)).toEqual(['DELETE', 'POST']);
    expect((await readSaved()).models).toEqual(publicModels(NEXT));
  });
  it('does not delete additional legacy resources exposed by clear', async () => {
    const server = await startWith((fake) =>
      fake.withIntended(INTENDED).withAdditionalIntended(NEXT),
    );
    const result = await setFile({ ...(await readSaved()), models: [] });
    expect(result.exitCode).toBe(1);
    expect(writes(server).map(({ method }) => method)).toEqual(['DELETE']);
    backupFrom(result.stderr);
    expect((await readSaved()).models).toEqual(publicModels(NEXT));
  });
  it('confirms POST committed before its response failed without another write', async () => {
    const server = await startWith((fake) => fake.failCommittedIntendedCreate(1));
    expect((await setFile({ models: [...NEXT, TS_MODEL] })).exitCode).toBe(0);
    expect(writes(server).map(({ method }) => method)).toEqual(['POST']);
    expect((await readSaved()).models).toEqual(publicModels([...NEXT, TS_MODEL]));
  });
  for (const hasOtherLanguage of [false, true]) {
    it(`removes a scoped language using ${hasOtherLanguage ? 'PATCH of survivors' : 'DELETE of the last perspective'}`, async () => {
      const original = hasOtherLanguage ? [...INTENDED, TS_MODEL] : INTENDED;
      const server = await startWith((fake) => fake.withIntended(original));
      const result = await setFile({ ...(await readSaved()), language: 'java', models: [] });
      expect(result.exitCode).toBe(0);
      expect(writes(server).map(({ method }) => method)).toEqual([
        hasOtherLanguage ? 'PATCH' : 'DELETE',
      ]);
      expect((await readSaved()).models).toEqual(publicModels(hasOtherLanguage ? [TS_MODEL] : []));
    });
  }
  it('does not trust a successful PATCH response when the public read returns different persisted content', async () => {
    const response = {
      intendedArchitectures: NEXT.map((model) => ({
        ...model,
        id: '00000000-0000-4000-8000-000000000001',
      })),
    };
    const server = await startWith((fake) =>
      fake
        .withIntended(INTENDED)
        .withStatus('intended-architectures', 200, JSON.stringify(response), 'PATCH'),
    );
    const result = await setFile({ ...(await readSaved()), models: NEXT });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('public read after writing did not confirm');
    backupFrom(result.stderr);
    expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
    expect((await readSaved()).models).toEqual(publicModels(INTENDED));
  });
  it('does not roll back a same-resource concurrent edit observed after successful PATCH', async () => {
    const concurrent = [{ ...NEXT[0], groups: [{ label: 'Concurrent', patterns: [] }] }];
    const server = await startWith((fake) =>
      fake.withIntended(INTENDED).changeIntendedBeforeRead(4, concurrent, true),
    );
    const result = await setFile({ ...(await readSaved()), models: NEXT });
    expect(result.exitCode).toBe(1);
    backupFrom(result.stderr);
    expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
    expect((await readSaved()).models).toEqual(publicModels(concurrent));
  });

  const partialModel = { ...NEXT[0], partial: true };
  const hiddenModel = {
    ...NEXT[0],
    groups: [{ label: 'Domain', groups: [{ label: 'Child', hiddenSubgroups: 1 }] }],
  };
  for (const [name, file] of [
    ['component', { component: 'Domain', models: NEXT }],
    ['depth', { depth: 1, models: NEXT }],
    ['partial model', { models: [partialModel] }],
    ['bare partial model', [partialModel]],
    ['hidden subgroups', { models: [hiddenModel] }],
    ['bare hidden subgroups', [hiddenModel]],
  ] as const) {
    it(`rejects MCP ${name} before architecture requests`, async () => {
      const server = await startWith((fake) => fake.withIntended(INTENDED));
      const saved = await readSaved();
      const count = server.getRecordedRequests().length;
      const input = Array.isArray(file) ? file : { ...file, revision: saved.revision };
      const result = await setFile(input);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('partial view');
      expect(
        server
          .getRecordedRequests()
          .slice(count)
          .filter(({ path }) => path.startsWith('/architecture/')),
      ).toEqual([]);
      expect(writes(server)).toEqual([]);
      expect((await readSaved()).models).toEqual(publicModels(INTENDED));
    });
  }
  for (const body of [
    JSON.stringify({ intendedArchitectures: INTENDED }),
    JSON.stringify({ intendedArchitectures: [{ ...INTENDED[0], id: 'bad-id' }] }),
  ]) {
    it(`rejects malformed public model identity before writing: ${body}`, async () => {
      const server = await startWith((fake) =>
        fake.withStatus('intended-architectures', 200, body, 'GET'),
      );
      expect((await setFile({ models: NEXT })).exitCode).toBe(1);
      expect(writes(server)).toEqual([]);
    });
  }
  for (const body of [
    JSON.stringify({ id: '00000000-0000-4000-8000-000000000001' }),
    JSON.stringify({ intendedArchitectures: [] }),
    JSON.stringify({ intendedArchitectures: [{ ...NEXT[0], id: 'invalid-id' }] }),
  ]) {
    it(`rejects malformed POST response envelope: ${body}`, async () => {
      const server = await startWith((fake) =>
        fake.withStatus('intended-architectures', 201, body, 'POST'),
      );
      expect((await setFile({ models: NEXT })).exitCode).toBe(1);
      expect(writes(server).map(({ method }) => method)).toEqual(['POST']);
      expect((await readSaved()).models).toEqual([]);
    });
  }
  for (const create of [false, true]) {
    it(`confirms ${create ? 'POST' : 'PATCH'} after a stale write body and delayed public reads`, async () => {
      const server = await startWith((fake) => {
        if (!create) fake.withIntended(INTENDED);
        fake.withStaleWriteResponse();
        const firstRead = create ? 2 : 3;
        fake.staleIntendedRead(firstRead).staleIntendedRead(firstRead + 1);
      });
      const result = await setFile({ models: NEXT });
      expect(result.exitCode).toBe(0);
      expect(writes(server).map(({ method }) => method)).toEqual([create ? 'POST' : 'PATCH']);
      expect((await readSaved()).models).toEqual(publicModels(NEXT));
    });
  }
  it('recovers from a transient verification read failure without repeating PATCH', async () => {
    const server = await startWith((fake) => fake.withIntended(INTENDED).failIntendedRead(3));
    expect((await setFile({ models: NEXT })).exitCode).toBe(0);
    expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
    expect((await readSaved()).models).toEqual(publicModels(NEXT));
  });
  it('rejects a replacement identity even when its content matches the requested model', async () => {
    const server = await startWith((fake) =>
      fake.withIntended(INTENDED).changeIntendedBeforeRead(3, NEXT),
    );
    const result = await setFile({ models: NEXT });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('identity changed');
    expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
    expect((await readSaved()).models).toEqual(publicModels(NEXT));
  });
  it('rejects a mismatched PATCH response without rollback', async () => {
    const server = await startWith((fake) =>
      fake.withIntended(INTENDED).withStatus(
        'intended-architectures',
        200,
        JSON.stringify({
          intendedArchitectures: INTENDED.map((model) => ({
            ...model,
            id: '00000000-0000-4000-8000-000000000001',
          })),
        }),
        'PATCH',
      ),
    );
    const result = await setFile({ ...(await readSaved()), models: NEXT });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('public read after writing did not confirm');
    backupFrom(result.stderr);
    expect(writes(server).map(({ method }) => method)).toEqual(['PATCH']);
    expect((await readSaved()).models).toEqual(publicModels(INTENDED));
  });
});

function publicModels(models: IntendedArchitecture[]): IntendedArchitecture[] {
  function group(
    value: IntendedArchitecture['groups'][number],
  ): IntendedArchitecture['groups'][number] {
    return {
      ...value,
      groups: (value.groups ?? []).map(group),
      interface: value.interface ?? false,
      interfaceAccess: value.interfaceAccess ?? false,
    };
  }
  return models.map((model) => ({ ...model, groups: model.groups.map(group) }));
}

describe('fake current architecture branch lookup', () => {
  for (const branchId of [undefined, '11111111-2222-4333-8444-555555555555']) {
    it(`returns ${branchId === undefined ? '400 for a missing branch' : 'an empty 200 for an unknown branch'}`, async () => {
      const response = routeArchitectureRequest(
        {
          method: 'GET',
          path: '/architecture/current-architectures',
          query: { organizationId: 'org', ecosystem: 'ts', ...(branchId ? { branchId } : {}) },
        },
        [],
        true,
      )!;
      expect(response.status).toBe(branchId === undefined ? 400 : 200);
      if (branchId !== undefined)
        expect(await response.json()).toEqual({ currentArchitectures: [] });
    });
  }
});

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

// Integration tests for current and intended architecture reads.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type {
  IntendedArchitecture,
  StructureGraph,
} from '@/commands/architecture/_common/architecture-api.ts';

import {
  SYNTHETIC_GRAPH,
  SYNTHETIC_MODULE_COUNT,
  SYNTHETIC_NODE_COUNT,
} from '../../../fixtures/architecture/synthetic-graph';
import { TestHarness } from '../../harness';
import { fakeMainBranchId } from '../../harness/fake-architecture';
import type { ProjectBuilder } from '../../harness/fake-sonarqube-server';

const TOKEN = 'arch-token';
const PROJECT = 'synthetic-project';

const SMALL_GRAPH: StructureGraph[] = [
  {
    id: 'graph-small',
    nodeCount: 3,
    edgeCount: 1,
    nodes: [
      {
        id: 1,
        name: 'app',
        kind: 'module',
        edges: [],
        nodes: [
          { id: 2, name: 'com.example.web', kind: 'package', edges: [{ toId: 3, weight: 4 }] },
        ],
      },
      {
        id: 4,
        name: 'core',
        kind: 'module',
        edges: [],
        nodes: [{ id: 3, name: 'com.example.domain', kind: 'package', edges: [] }],
      },
    ],
  },
];

const INTENDED: IntendedArchitecture[] = [
  {
    type: 'namespace',
    language: 'java',
    groups: [
      {
        label: 'Domain',
        patterns: ['core:com.example.domain.**'],
        groups: [{ label: 'Billing', patterns: ['core:com.example.domain.billing.**'] }],
      },
      { label: 'Web', patterns: ['app:**'] },
    ],
    constraints: [{ from: 'Web', to: 'Domain' }],
  },
];

interface CurrentPayload {
  project: string;
  languages: Array<{
    language: string;
    summary: string;
    root: string;
    totalNodes: number;
    nodes: Array<{ key: string; kind: string; truncated: boolean }>;
    edges: Array<{ from: string; to: string; weight: number }>;
    feedbackPairs: { total: number; heaviest: Array<{ from: string; to: string; weight: number }> };
    outsideViewWeight: number;
    capped: boolean;
    omittedEdges: number;
    depth: number;
    requestedDepth: number;
    nodeLimit: number;
    levels: Array<{ depth: number; nodes: number }>;
    omittedLevel?: { depth: number; nodes: number };
    drillDown: string[];
  }>;
}

describe('sonar architecture reads', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function serverWith(configure: (project: ProjectBuilder) => void = () => undefined) {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken(TOKEN)
      .withProject(PROJECT, configure)
      .start();
    harness.withAuth(server.recordedAuthServerUrl(), TOKEN, 'my-org');
    return server;
  }

  it('exposes architecture commands and the arch alias without an Alpha flag', async () => {
    const result = await harness.run('architecture --help');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('current');
    expect(result.stdout).not.toContain('[ALPHA]');
    expect(result.stdout).toContain('install-skill');
    const alias = await harness.run('arch --help');
    expect(alias.exitCode).toBe(0);
    const help = await harness.run('--help');
    expect(help.stdout).toContain('architecture|arch');
  });

  it(
    'lists architecture with its arch alias in the root help',
    async () => {
      const help = await harness.run('--help');
      expect(help.stdout).toContain('architecture|arch <command>');
    },
    { timeout: 15000 },
  );

  it('caps edges and feedback pairs across languages while preserving totals', async () => {
    const dense = (weight: number): StructureGraph => ({
      nodeCount: 8,
      edgeCount: 56,
      nodes: Array.from({ length: 8 }, (_, id) => ({
        id,
        name: `node-${id}`,
        kind: 'module',
        edges: Array.from({ length: 8 }, (_, toId) => ({
          toId,
          weight: weight + id + toId,
        })).filter((edge) => edge.toId !== id),
      })),
    });
    await serverWith((project) =>
      project.withArchitecture((architecture) =>
        architecture.withStructure('java', [dense(1)]).withStructure('ts', [dense(100)]),
      ),
    );
    const command = `architecture current get -p ${PROJECT} --format json`;
    const result = await harness.run(command);
    expect(result.exitCode).toBe(0);
    const { languages } = JSON.parse(result.stdout) as CurrentPayload;
    expect(languages).toHaveLength(2);
    expect(languages.reduce((count, view) => count + view.edges.length, 0)).toBe(20);
    expect(languages.reduce((count, view) => count + view.feedbackPairs.heaviest.length, 0)).toBe(
      5,
    );
    for (const view of languages) {
      expect(view.feedbackPairs.total).toBe(28);
      expect(view.edges.length + view.omittedEdges).toBe(56);
    }
    expect(languages[0].edges).toHaveLength(0);
    expect(languages[0].summary).toContain(
      'No dependencies shown within the shared response budget',
    );
    expect(languages[0].summary).toContain(
      'No feedback pairs shown within the shared response budget',
    );
    const text = await harness.run(`architecture current get -p ${PROJECT} --format text`);
    expect(text.stdout).toContain('56 dependencies: none shown within the shared response budget');
    expect(text.stdout).toContain(
      '28 feedback pair(s): none shown within the shared response budget',
    );
    expect(languages[1].edges.every((edge) => edge.weight >= 100)).toBe(true);
    expect(languages[0].nodes.map(({ key }) => key)).toEqual(
      Array.from({ length: 8 }, (_, id) => `node-${id}`),
    );
    const repeated = await harness.run(command);
    expect(JSON.parse(repeated.stdout)).toEqual(JSON.parse(result.stdout));
  });

  it(
    'caps a large project and points to drill-down commands',
    async () => {
      await serverWith((p) => p.withArchitecture((a) => a.withStructure('java', SYNTHETIC_GRAPH)));

      const result = await harness.run(
        `architecture current get --project ${PROJECT} --depth 3 --format json`,
      );

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as CurrentPayload;
      expect(payload.languages).toHaveLength(1);
      const [java] = payload.languages;
      expect(java.capped).toBe(true);
      expect(java.totalNodes).toBe(SYNTHETIC_NODE_COUNT);
      expect(java.nodes.length).toBeLessThanOrEqual(150);
      expect(java.drillDown.length).toBeGreaterThan(0);
      expect(java.drillDown[0]).toStartWith(
        `sonar architecture current get --project ${PROJECT} --component `,
      );
      expect(java.summary).toContain('would exceed the 150-node cap');
      expect(java.requestedDepth).toBe(3);
      expect(java.depth).toBe(2);
      expect(java.nodeLimit).toBe(150);
      expect(java.nodes).toHaveLength(56);
      expect(java.levels).toEqual([
        { depth: 1, nodes: 28 },
        { depth: 2, nodes: 28 },
      ]);
      expect(java.omittedLevel).toEqual({ depth: 3, nodes: 168 });
      expect(result.stdout.length).toBeLessThan(JSON.stringify(SYNTHETIC_GRAPH).length / 2);
    },
    { timeout: 15000 },
  );

  it(
    'shows the top-level modules first, and the alias gives the same output in toon',
    async () => {
      await serverWith((p) => p.withArchitecture((a) => a.withStructure('java', SYNTHETIC_GRAPH)));

      const full = await harness.run(
        `architecture current get --project ${PROJECT} --language java --format json`,
      );
      const payload = JSON.parse(full.stdout) as CurrentPayload;
      expect(payload.languages[0].capped).toBe(false);
      expect(payload.languages[0].nodes).toHaveLength(SYNTHETIC_MODULE_COUNT);
      expect(payload.languages[0].nodes.every((node) => node.kind === 'module')).toBe(true);
      expect(payload.languages[0].edges.length).toBeGreaterThan(0);

      const viaAlias = await harness.run(`arch current get --project ${PROJECT} --language java`);
      const viaName = await harness.run(
        `architecture current get --project ${PROJECT} --language java`,
      );
      expect(viaAlias.exitCode).toBe(0);
      expect(viaAlias.stdout).toBe(viaName.stdout);
      expect(viaAlias.stdout).toContain('summary: "Showing 28 of 1568 nodes');
    },
    { timeout: 15000 },
  );

  it(
    'drills down into a component and rolls dependencies up to the visible nodes',
    async () => {
      await serverWith((p) => p.withArchitecture((a) => a.withStructure('java', SYNTHETIC_GRAPH)));

      const result = await harness.run(
        `architecture current get --project ${PROJECT} --component module-00 --depth 2 --format json`,
      );

      expect(result.exitCode).toBe(0);
      const [java] = (JSON.parse(result.stdout) as CurrentPayload).languages;
      expect(java.root).toBe('module-00');
      expect(java.nodes.length).toBeGreaterThan(0);
      expect(java.nodes.every((node) => node.key.startsWith('module-00:'))).toBe(true);
      expect(
        java.edges.every((edge) => edge.from.startsWith('module-00:') && edge.to !== edge.from),
      ).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'reports feedback pairs and the weight to nodes outside the view',
    async () => {
      await serverWith((p) => p.withArchitecture((a) => a.withStructure('java', SYNTHETIC_GRAPH)));

      const result = await harness.run(
        `architecture current get --project ${PROJECT} --component module-00 --depth 2 --format json`,
      );

      expect(result.exitCode).toBe(0);
      const [java] = (JSON.parse(result.stdout) as CurrentPayload).languages;
      expect(java.feedbackPairs.total).toBe(15);
      expect(java.feedbackPairs.heaviest).toHaveLength(5);
      expect(java.feedbackPairs.heaviest[0]).toEqual({
        from: 'module-00:com.example.synthetic.layer0',
        to: 'module-00:com.example.synthetic.layer1',
        weight: 148,
      });
      expect(java.outsideViewWeight).toBe(144);
    },
    { timeout: 15000 },
  );

  it(
    'prints one drill-down command per line in toon',
    async () => {
      await serverWith((p) => p.withArchitecture((a) => a.withStructure('java', SYNTHETIC_GRAPH)));

      const result = await harness.run(`architecture current get --project ${PROJECT}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        [
          '    drillDown[5]{command}:',
          ...['module-00', 'module-01', 'module-02', 'module-03', 'module-04'].map(
            (key) => `      sonar architecture current get --project ${PROJECT} --component ${key}`,
          ),
        ].join('\n'),
      );
    },
    { timeout: 15000 },
  );

  it(
    'prints a text summary with --format text, and by default on a terminal',
    async () => {
      await serverWith((p) => p.withArchitecture((a) => a.withStructure('java', SYNTHETIC_GRAPH)));
      const command = `architecture current get --project ${PROJECT} --component module-00 --depth 2`;

      const text = await harness.run(`${command} --format text`);

      expect(text.exitCode).toBe(0);
      const lines = text.stdout.trimEnd().split('\n');
      expect(lines[0]).toBe(
        `${PROJECT} (java): 1 top-level group(s): com.example.synthetic — 7 of 55 node(s) in view, 2 level(s) below module-00`,
      );
      expect(lines[1]).toBe('Names are relative to com.example.synthetic');
      expect(lines[2]).toBe('30 dependencies, heaviest 20:');
      expect(lines).toContain('15 feedback pair(s), heaviest 5:');
      expect(lines).toContain('  layer0 <-> layer1  (148)');
      expect(lines).toContain('  … 10 more pair(s)');
      expect(lines).toContain('plus 144 units to nodes outside this view');
      const drillDown = lines.slice(lines.indexOf('Drill down:') + 1);
      expect(drillDown).toHaveLength(5);
      expect(
        drillDown.every((line) =>
          line.startsWith(`  sonar architecture current get --project ${PROJECT} --component `),
        ),
      ).toBe(true);

      const onTerminal = await harness.run(command, { extraEnv: { SONARQUBE_CLI_MOCK_TTY: '1' } });
      expect(onTerminal.stdout).toBe(text.stdout);
    },
    { timeout: 15000 },
  );

  it(
    'fails clearly on an unknown component',
    async () => {
      await serverWith((p) => p.withArchitecture((a) => a.withStructure('java', SMALL_GRAPH)));

      const result = await harness.run(
        `architecture current get --project ${PROJECT} --component nope`,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No node 'nope' in the current architecture.");
      expect(result.stderr).toContain("'sonar architecture current get' without --component");
    },
    { timeout: 15000 },
  );

  it(
    'queries all five languages in parallel, and only one with --language',
    async () => {
      const server = await serverWith((p) =>
        p.withArchitecture((a) => a.withStructure('java', SMALL_GRAPH)),
      );

      const all = await harness.run(`architecture current get --project ${PROJECT} --format json`);
      expect(all.exitCode).toBe(0);
      const structureCalls = () =>
        server
          .getRecordedRequests()
          .filter((request) => request.path === '/architecture/current-architectures');
      expect(
        structureCalls()
          .map((request) => request.query.language)
          .sort(),
      ).toEqual(['cs', 'java', 'js', 'py', 'ts']);
      for (const call of structureCalls()) {
        expect(call.query.organizationId).toBe('my-org-uuid-v4');
        expect(call.query.branchId).toBe(fakeMainBranchId(PROJECT));
      }
      const payload = JSON.parse(all.stdout) as CurrentPayload;
      expect(payload.languages.map(({ language }) => language)).toEqual(['java']);
      expect(payload.languages[0].edges).toEqual([{ from: 'app', to: 'core', weight: 4 }]);

      const before = structureCalls().length;
      await harness.run(`architecture current get --project ${PROJECT} --language ts`);
      expect(structureCalls().length - before).toBe(1);
    },
    { timeout: 15000 },
  );

  it(
    'reports an empty current response without claiming why data is missing',
    async () => {
      await serverWith();

      const result = await harness.run(
        `architecture current get --project ${PROJECT} --format json`,
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ project: PROJECT, languages: [] });
      expect(result.stderr).toContain(`No current architecture was returned for '${PROJECT}'`);
      expect(result.stderr).toContain('does not indicate whether analysis is missing');
      expect(result.stderr).not.toContain('Run an analysis');
    },
    { timeout: 15000 },
  );

  it(
    'explains a 403 instead of a generic access error',
    async () => {
      await serverWith((p) =>
        p.withArchitecture((a) => a.withStatus('current-architectures', 403)),
      );

      const result = await harness.run(`architecture current get --project ${PROJECT}`);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `The Architecture API refused access to '${PROJECT}' (HTTP 403).`,
      );
      expect(result.stderr).toContain('Architecture needs SonarQube Cloud Team or Enterprise');
    },
    { timeout: 15000 },
  );

  it(
    'uses the Cloud API paths, the organization uuid and the main branch id as projectId',
    async () => {
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .asSonarCloud()
        .withAuthToken(TOKEN)
        .withProject(PROJECT, (p) =>
          p.withArchitecture((a) => a.withStructure('java', SMALL_GRAPH).withIntended(INTENDED)),
        )
        .start();
      harness.withAuth(server.recordedAuthServerUrl(), TOKEN, 'my-org');

      const current = await harness.run(
        `architecture current get --project ${PROJECT} --language java --format json`,
      );
      const intended = await harness.run(
        `architecture intended get --project ${PROJECT} --format json`,
      );

      expect(current.exitCode).toBe(0);
      expect(intended.exitCode).toBe(0);
      const requests = server.getRecordedRequests();
      const structure = requests.find(
        (request) => request.path === '/architecture/current-architectures',
      );
      expect(structure?.query).toEqual({
        organizationId: 'my-org-uuid-v4',
        branchId: fakeMainBranchId(PROJECT),
        language: 'java',
      });
      const intendedCall = requests.find(
        (request) => request.path === '/architecture/intended-architectures',
      );
      expect(intendedCall?.query).toEqual({ projectId: fakeMainBranchId(PROJECT) });
    },
    { timeout: 15000 },
  );

  it(
    'prints the full intended architecture with a revision, filtered by --language',
    async () => {
      const server = await serverWith((p) => p.withArchitecture((a) => a.withIntended(INTENDED)));

      const result = await harness.run(
        `architecture intended get --project ${PROJECT} --format json`,
      );
      const python = await harness.run(
        `architecture intended get --project ${PROJECT} --language py --format json`,
      );

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout) as { revision: string; models: unknown[] };
      expect(payload.models).toEqual(publicModels(INTENDED));
      expect(payload.revision).toMatch(/^[0-9a-f]{64}$/);
      const intendedCall = server
        .getRecordedRequests()
        .find((request) => request.path === '/architecture/intended-architectures');
      expect(intendedCall?.query).toEqual({ projectId: fakeMainBranchId(PROJECT) });

      expect(python.exitCode).toBe(0);
      expect((JSON.parse(python.stdout) as { models: unknown[] }).models).toEqual([]);
      expect(python.stderr).toContain(`No intended architecture yet for '${PROJECT}'`);
    },
    { timeout: 15000 },
  );

  it(
    'gives the revision of the whole stored model whatever --language, --component or --depth',
    async () => {
      const TS_MODEL: IntendedArchitecture = {
        type: 'file',
        language: 'ts',
        groups: [{ label: 'Ui', patterns: ['src/ui/**'] }],
        constraints: [],
      };
      await serverWith((p) => p.withArchitecture((a) => a.withIntended([...INTENDED, TS_MODEL])));
      const read = async (flags: string) =>
        JSON.parse(
          (
            await harness.run(
              `architecture intended get --project ${PROJECT} ${flags} --format json`,
            )
          ).stdout,
        ) as { revision: string; language?: string; models: IntendedArchitecture[] };

      const whole = await read('');
      const java = await read('--language java');
      const domain = await read('--language java --component Domain --depth 1');

      expect(whole.language).toBeUndefined();
      expect(java.language).toBe('java');
      expect(java.models).toEqual(publicModels(INTENDED));
      expect(java.revision).toBe(whole.revision);
      expect(domain.revision).toBe(whole.revision);
    },
    { timeout: 15000 },
  );

  it(
    'prints the intended groups tree with --format text, and by default on a terminal',
    async () => {
      await serverWith((p) => p.withArchitecture((a) => a.withIntended(INTENDED)));
      const command = `architecture intended get --project ${PROJECT}`;

      const text = await harness.run(`${command} --format text`);
      const json = JSON.parse((await harness.run(`${command} --format json`)).stdout) as {
        revision: string;
      };

      expect(text.exitCode).toBe(0);
      expect(text.stdout.trimEnd().split('\n')).toEqual([
        `${PROJECT}: intended architecture`,
        'java (namespace): 3 group(s), 1 constraint(s)',
        '  Domain [core:com.example.domain.**]',
        '    Billing [core:com.example.domain.billing.**]',
        '  Web [app:**]',
        '  allowed:',
        '    Web -> Domain',
        `revision ${json.revision}`,
      ]);
      const onTerminal = await harness.run(command, { extraEnv: { SONARQUBE_CLI_MOCK_TTY: '1' } });
      expect(onTerminal.stdout).toBe(text.stdout);
    },
    { timeout: 15000 },
  );

  it(
    'shows a partial view of the groups below --component, limited by --depth',
    async () => {
      await serverWith((p) => p.withArchitecture((a) => a.withIntended(INTENDED)));

      const top = await harness.run(
        `architecture intended get --project ${PROJECT} --depth 1 --format json`,
      );
      const domain = await harness.run(
        `architecture intended get --project ${PROJECT} --component Domain --format json`,
      );
      const unknown = await harness.run(
        `architecture intended get --project ${PROJECT} --component Nope`,
      );

      const topView = JSON.parse(top.stdout) as Record<string, unknown>;
      expect(topView.revision).toMatch(/^[0-9a-f]{64}$/);
      expect(topView).toEqual({
        project: PROJECT,
        revision: topView.revision,
        partial: true,
        models: [
          {
            type: 'namespace',
            language: 'java',
            root: '',
            groups: [
              { key: 'Domain', patterns: ['core:com.example.domain.**'], hiddenSubgroups: 1 },
              { key: 'Web', patterns: ['app:**'] },
            ],
            constraints: [{ from: 'Web', to: 'Domain' }],
          },
        ],
      });
      const domainView = JSON.parse(domain.stdout) as {
        models: Array<{ root: string; groups: Array<{ key: string }> }>;
      };
      expect(domainView.models[0].root).toBe('Domain');
      expect(domainView.models[0].groups.map(({ key }) => key)).toEqual(['Domain/Billing']);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr).toContain("No group 'Nope' in the intended architecture.");
    },
    { timeout: 15000 },
  );
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

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

import type { ProjectFinding } from '@/commands/architecture/_common/findings.ts';

import { TestHarness } from '../../harness';
import type { FakeArchitecture } from '../../harness/fake-architecture';

const findings: ProjectFinding[] = [
  {
    type: 'structuralDeviation',
    category: 'deviation',
    language: 'java',
    details: { reason: 'misplacedComponent', nodeKey: 'app:web', misplacedComponentCount: 3 },
    files: ['Web.java'],
  },
  {
    type: 'structuralDeviation',
    category: 'deviation',
    language: 'java',
    details: { reason: 'unimplementedComponent', nodeKey: 'app:missing' },
    files: [],
  },
  {
    type: 'relationshipDeviation',
    category: 'deviation',
    language: 'java',
    details: {
      reason: 'disallowedDependency',
      fromNodeKey: 'app:web',
      toNodeKey: 'app:db',
      dependencyCount: 4,
    },
    files: ['Web.java'],
  },
  {
    type: 'relationshipDeviation',
    category: 'deviation',
    language: 'java',
    details: { reason: 'interfaceViolation', fromNodeKey: 'app:web', toNodeKey: 'app:internal' },
    files: [],
  },
  {
    type: 'tangle',
    category: 'flaw',
    language: 'java',
    details: { nodeKeys: ['a', 'b'], nodeCount: 2 },
    files: [],
  },
  {
    type: 'oversizedComponent',
    category: 'flaw',
    language: 'java',
    details: { nodeKey: 'large', leafArtifactCount: 40 },
    files: [],
  },
  {
    type: 'weakTangle',
    category: 'smell',
    language: 'ts',
    details: { nodeKeys: ['c', 'd'], nodeCount: 2 },
    files: [],
  },
  {
    type: 'splitResponsibility',
    category: 'smell',
    language: 'ts',
    details: { nodeKey: 'util', fragmentCount: 3 },
    files: [],
  },
];

describe('public architecture findings contract', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await TestHarness.create();
  });
  afterEach(async () => {
    await h.dispose();
  });
  async function configured(
    cloud = true,
    configure: (api: FakeArchitecture) => void = (api) => api.withFindings(findings),
  ) {
    const builder = h
      .newFakeServer()
      .withVersion('2026.6')
      .withAuthToken('findings-token')
      .withProject('shop', (p) => p.withArchitecture(configure));
    if (cloud) builder.asSonarCloud();
    const server = await builder.start();
    h.withAuth(server.recordedAuthServerUrl(), 'findings-token', cloud ? 'my-org' : undefined);
    return server;
  }
  const requests = (server: Awaited<ReturnType<typeof configured>>) =>
    server.getRecordedRequests().filter((r) => r.path.includes('project-findings'));

  for (const cloud of [true, false]) {
    it.each(['main', 'trunk'])(
      `rejects an unanalyzed %s main branch on Cloud=${cloud}`,
      async (main) => {
        const builder = h
          .newFakeServer()
          .withVersion('2026.6')
          .withAuthToken('findings-token')
          .withProject('shop', (p) =>
            p
              .withDefaultBranchName(main)
              .withUnanalyzedBranch(main)
              .withArchitecture((api) => api.withFindings([])),
          );
        const server = await (cloud ? builder.asSonarCloud() : builder).start();
        h.withAuth(server.recordedAuthServerUrl(), 'findings-token', cloud ? 'my-org' : undefined);
        const result = await h.run('arch findings get -p shop --format text');
        if (!cloud) {
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain(
            'The sonar architecture command requires a SonarQube Cloud connection.',
          );
          return;
        }
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Project 'shop' has no analyzed main branch.");
        expect(result.stderr).toContain('Run an analysis of the main branch first.');
        expect(result.stdout).not.toContain('No findings');
        expect(requests(server)).toHaveLength(0);
      },
    );
  }

  it.each([true, false])(
    'uses organization and analyzed branch on Cloud=%s without project UUID lookup',
    async (cloud) => {
      const server = await configured(cloud);
      const result = await h.run('arch findings get -p shop --format json');
      if (!cloud) {
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          'The sonar architecture command requires a SonarQube Cloud connection.',
        );
        return;
      }
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        project: 'shop',
        findings,
        page: { pageIndex: 1, pageSize: 50, total: 8 },
      });
      const [request] = requests(server);
      expect(request.path).toBe('/architecture/project-findings');
      expect(request.query).toMatchObject({
        branchId: 'shop-branch-id',
        pageIndex: '1',
        pageSize: '50',
      });
      expect(request.query.organizationId).toBe('my-org-uuid-v4');
      expect(request.query.projectId).toBeUndefined();
      expect(request.query.language).toBeUndefined();
      expect(
        server.getRecordedRequests().some((r) => r.path === '/api/v2/components/projects'),
      ).toBe(false);
      expect(request.method).toBe('GET');
    },
  );
  it('keeps the existing Cloud-only gate for summary reads', async () => {
    const server = await configured(false);
    const result = await h.run('arch current get --summary -p shop --format json');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'The sonar architecture command requires a SonarQube Cloud connection.',
    );
    expect(server.getRecordedRequests().some((r) => r.path.includes('project-summaries'))).toBe(
      false,
    );
  });

  it.each(['--component app', '--depth 2', '--from a --to b', '--page 1', '--page-size 1'])(
    'rejects graph filters with summary: %s',
    async (filter) => {
      const server = await configured();
      const result = await h.run(`arch current get --summary -p shop ${filter} --format json`);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        '--summary cannot be combined with graph or dependency filters',
      );
      expect(server.getRecordedRequests().some((r) => r.path.includes('project-summaries'))).toBe(
        false,
      );
    },
  );

  it('returns a separate summary for each available language', async () => {
    await configured();
    const result = await h.run('arch current get --summary -p shop --format json');
    expect(result.exitCode).toBe(0);
    const summaries = JSON.parse(result.stdout).summaries;
    expect(summaries.map((item: { language: string }) => item.language)).toEqual(['java', 'ts']);
    expect(summaries[1].smells).toEqual({ total: 2, weakTangle: 1, splitResponsibility: 1 });
  });

  it('reports unavailable summary data without inventing zero counts', async () => {
    await configured(true, (api) => api.withFindings([]));
    const result = await h.run('arch current get --summary -p shop --format json');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      project: 'shop',
      summaries: [],
      message: 'No architecture summaries are visible. Check project access and analysis.',
    });
  });

  it('reports summary API permission errors', async () => {
    await configured(true, (api) => api.withStatus('project-summaries', 403));
    const result = await h.run('arch current get --summary -p shop --format json');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('403');
  });

  it('rejects an invalid summary response', async () => {
    await configured(true, (api) =>
      api.withStatus('project-summaries', 200, '{"projectSummaries":[{}]}'),
    );
    const result = await h.run('arch current get --summary -p shop --format json');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Invalid public architecture summary response');
  });

  it('reads summary counts with the public branch scope and language filter', async () => {
    const server = await configured();
    const result = await h.run('arch current get --summary -p shop --language java --format json');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      project: 'shop',
      summaries: [
        {
          language: 'java',
          deviations: { total: 4, structuralDeviation: 2, relationshipDeviation: 2 },
          flaws: { total: 2, tangle: 1, oversizedComponent: 1 },
          smells: { total: 0, weakTangle: 0, splitResponsibility: 0 },
        },
      ],
    });
    const request = server
      .getRecordedRequests()
      .find((r) => r.path === '/architecture/project-summaries');
    expect(request?.query).toMatchObject({
      organizationId: 'my-org-uuid-v4',
      branchId: 'shop-branch-id',
      language: 'java',
    });
  });

  it.each(['deviation', 'flaw', 'smell'])('filters category %s', async (category) => {
    const server = await configured();
    const result = await h.run(`arch findings get -p shop --category ${category} --format json`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).findings).toEqual(
      findings.filter((f) => f.category === category),
    );
    expect(requests(server)[0].query.category).toBe(category);
  });
  it.each([
    ['--type tangle --type weakTangle', '--type'],
    ['--type weakTangle --type tangle', '--type'],
    ['--type tangle --type tangle', '--type'],
    ['--type=tangle --type=weakTangle', '--type'],
    ['--category flaw --category smell', '--category'],
    ['--category smell --category flaw', '--category'],
    ['--category flaw --category flaw', '--category'],
    ['--category=flaw --category=smell', '--category'],
    ['--language java --language ts', '--language'],
    ['--language ts --language java', '--language'],
    ['--language java --language java', '--language'],
    ['--language=java --language=ts', '--language'],
  ])('rejects repeated Findings filters: %s', async (options, flag) => {
    const server = await configured();
    const result = await h.run(`arch findings get -p shop ${options} --format json`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`${flag} can only be specified once.`);
    expect(server.getRecordedRequests()).toHaveLength(0);
  });
  it.each([
    '--types tangle',
    '--categories flaw',
    '--page-index 2',
    '--type tangle,weakTangle',
    '--category flaw,smell',
  ])('rejects unsupported Findings parameter forms: %s', async (options) => {
    const server = await configured();
    const result = await h.run(`arch findings get -p shop ${options} --format json`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('error:');
    expect(server.getRecordedRequests()).toHaveLength(0);
  });
  it('combines type, category and language using AND', async () => {
    const server = await configured();
    const result = await h.run(
      'arch findings get -p shop --type relationshipDeviation --category deviation --language java --format json',
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).findings).toEqual(findings.slice(2, 4));
    expect(requests(server)[0].query).toMatchObject({
      type: 'relationshipDeviation',
      category: 'deviation',
      language: 'java',
    });
    const none = await h.run(
      'arch findings get -p shop --type relationshipDeviation --category smell --format json',
    );
    expect(none.exitCode).toBe(2);
    expect(none.stderr).toContain('type relationshipDeviation belongs to category deviation');
    expect(requests(server)).toHaveLength(1);
  });
  it('pages without requiring IDs or deduplicating identical findings', async () => {
    await configured(true, (api) => api.withFindings([findings[0], findings[0], findings[1]]));
    const text = await h.run('arch findings get -p shop --page-size 1 --format text');
    expect(text.stdout).toContain('Page 1: 1 of 3 findings. Use --page to continue.');
    expect(text.stdout).toContain('misplacedComponent');
    expect(text.stdout).toContain('Web.java');
    const second = await h.run('arch findings get -p shop --page-size 1 --page 2 --format json');
    expect(JSON.parse(second.stdout).findings).toEqual([findings[0]]);
  });
  it('counts with page size zero and does not advise changing the page index', async () => {
    await configured();
    const result = await h.run('arch findings get -p shop --page-size 0 --format text');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Page 1: 0 of 8 findings.');
    expect(result.stdout).toContain('Use --page-size greater than 0');
    expect(result.stdout).not.toContain('Use --page to continue');
  });
  it('does not interpret absence as a clean project or an incomplete report', async () => {
    await configured(true, (api) => api.withFindings([]));
    const result = await h.run('arch findings get -p shop --format text');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No findings are visible');
    expect(result.stdout).not.toContain('incomplete');
  });
  it('normalizes optional null counts and ignores unknown fields', async () => {
    await configured(true, (api) =>
      api.withStatus(
        'project-findings',
        200,
        JSON.stringify({
          findings: [
            {
              ...findings[5],
              id: 'unused',
              details: { nodeKey: 'large', leafArtifactCount: null, unknown: 'drop' },
              unknown: true,
            },
          ],
          page: { pageIndex: 1, pageSize: 50, total: 1 },
        }),
        'GET',
      ),
    );
    const result = await h.run('arch findings get -p shop --format json');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).findings).toEqual([
      { ...findings[5], details: { nodeKey: 'large' } },
    ]);
  });
  it.each([
    '--id missing',
    '--category DEVIATION',
    '--type unknown',
    '--language unknown',
    '--page-size -1',
    '--page-size 1001',
    '--page 0',
  ])('rejects invalid arguments %s', async (args) => {
    const server = await configured();
    const result = await h.run(`arch findings get -p shop ${args}`);
    expect(result.exitCode).not.toBe(0);
    expect(requests(server)).toHaveLength(0);
  });
  const invalidFindings = [
    { ...findings[0], details: { reason: 'interfaceViolation', nodeKey: 'a' } },
    { ...findings[2], details: { reason: 'misplacedComponent', fromNodeKey: 'a', toNodeKey: 'b' } },
    { ...findings[0], type: '' },
    { ...findings[0], language: '' },
    { ...findings[0], details: { reason: '', nodeKey: 'a' } },
    { ...findings[0], category: 'DEVIATION' },
    { ...findings[0], category: 'flaw' },
    { ...findings[0], details: null },
    { ...findings[0], files: [null] },
    { ...findings[2], details: { reason: 'disallowedDependency', fromNodeKey: 'a' } },
    { ...findings[4], details: { nodeKeys: ['a'], nodeCount: -1 } },
    { ...findings[5], details: { nodeKey: 'a', leafArtifactCount: '40' } },
  ];
  it.each(invalidFindings)('rejects malformed public finding %j', async (finding) => {
    await configured(true, (api) =>
      api.withStatus(
        'project-findings',
        200,
        JSON.stringify({ findings: [finding], page: { pageIndex: 1, pageSize: 50, total: 1 } }),
        'GET',
      ),
    );
    const result = await h.run('arch findings get -p shop');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Invalid public finding response');
    expect(result.stderr).toContain('sonar update');
  });
  it.each([
    { findings: [] },
    { projectFindings: [], page: { pageIndex: 1, pageSize: 50, total: 0 } },
    { findings: [], page: { pageIndex: 2, pageSize: 50, total: 0 } },
    { findings: [], page: { pageIndex: 1, pageSize: 50, total: -1 } },
  ])('rejects malformed pagination %j', async (body) => {
    await configured(true, (api) =>
      api.withStatus('project-findings', 200, JSON.stringify(body), 'GET'),
    );
    const result = await h.run('arch findings get -p shop');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Invalid public findings page');
    expect(result.stderr).toContain('sonar update');
  });
  it('rejects findings that do not match the requested filter', async () => {
    await configured(true, (api) =>
      api.withStatus(
        'project-findings',
        200,
        JSON.stringify({ findings: [findings[0]], page: { pageIndex: 1, pageSize: 50, total: 1 } }),
        'GET',
      ),
    );
    const result = await h.run('arch findings get -p shop --category smell');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('outside the requested filters');
    expect(result.stderr).toContain('sonar update');
  });
  for (const cloud of [true, false]) {
    it(`explains malformed findings pages on ${cloud ? 'Cloud' : 'Server'}`, async () => {
      await configured(cloud, (api) =>
        api.withStatus('project-findings', 200, '{"findings":null}', 'GET'),
      );
      const result = await h.run('arch findings get -p shop --format json');
      if (!cloud) {
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          'The sonar architecture command requires a SonarQube Cloud connection.',
        );
        return;
      }
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Invalid public findings page');
      expect(result.stderr).toContain('sonar update');
      expect(result.stderr).toContain('same public Architecture API');
    });

    it(`explains unreadable successful findings responses on ${cloud ? 'Cloud' : 'Server'}`, async () => {
      const server = await configured(cloud, (api) =>
        api.withStatus('project-findings', 200, '<html>Unexpected gateway page</html>', 'GET'),
      );
      const result = await h.run('arch findings get -p shop --format json');
      if (!cloud) {
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          'The sonar architecture command requires a SonarQube Cloud connection.',
        );
        return;
      }
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('public Architecture API returned an unreadable response');
      expect(result.stderr).toContain('sonar update');
      expect(result.stderr).not.toContain('<html>');
      expect(requests(server)).toHaveLength(1);
    });

    it(`explains an unavailable public findings endpoint on ${cloud ? 'Cloud' : 'Server'}`, async () => {
      const server = await configured(cloud, (api) =>
        api.withStatus('project-findings', 404, '{"message":"Missing endpoint"}', 'GET'),
      );
      const result = await h.run('arch findings get -p shop --format json');
      if (!cloud) {
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          'The sonar architecture command requires a SonarQube Cloud connection.',
        );
        return;
      }
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('public Architecture API endpoint was not found (HTTP 404)');
      expect(result.stderr).toContain('feature availability, Browse permission and API routing');
      expect(result.stderr).not.toContain('older Server versions');
      expect(requests(server)).toHaveLength(1);
    });
  }
  it.each([401, 403, 404, 500])('reports backend error %d without fallback', async (status) => {
    const server = await configured(true, (api) =>
      api.withStatus('project-findings', status, '{"message":"Unavailable"}', 'GET'),
    );
    const result = await h.run('arch findings get -p shop');
    expect(result.exitCode).toBe(1);
    if (status === 401) expect(result.stderr).toContain('SonarQube API error: 401');
    if (status === 403) {
      expect(result.stderr).toContain("The Architecture API refused access to 'shop' (HTTP 403)");
      expect(result.stderr).toContain('Check project permissions');
      expect(result.stderr).toContain('A Cloud gateway can also return 403');
      expect(result.stderr).toContain('sonar update');
    }
    if (status === 401) expect(result.stderr).not.toContain('sonar update');
    expect(requests(server).every((r) => r.path === '/architecture/project-findings')).toBe(true);
    expect(
      server
        .getRecordedRequests()
        .some(
          (r) =>
            r.path.includes('/architecture/structure') || r.path.includes('/architecture/graphs'),
        ),
    ).toBe(false);
  });
  it.each([
    '--page 1.5',
    '--page 1junk',
    '--page 1e2',
    '--page 0',
    '--page 2147483648',
    '--page 3000000000',
    '--page 9007199254740992',
    '--page-size 1.5',
    '--page-size -1',
    '--page-size 1001',
  ])('rejects strict pagination %s with exit 2 before any request', async (args) => {
    const server = await configured();
    const result = await h.run(`arch findings get -p shop ${args}`);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Finding');
    expect(result.stderr).not.toContain('at parse');
    expect(server.getRecordedRequests()).toHaveLength(0);
  });

  it('accepts the largest supported page index without changing it', async () => {
    const server = await configured();
    const result = await h.run(
      'arch findings get -p shop --page 2147483647 --page-size 1 --format json',
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).page.pageIndex).toBe(2147483647);
    expect(requests(server)[0]?.query.pageIndex).toBe('2147483647');
  });

  it('identifies active filters for a genuinely empty result', async () => {
    await configured(true, (api) => api.withFindings([]));
    const result = await h.run(
      'arch findings get -p shop --category smell --type weakTangle --language java --format text',
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('category=smell, type=weakTangle, language=java');
    expect(result.stdout).toContain('No findings match');
    expect(result.stdout).not.toContain('Check project access');
  });

  it('explains pages past the end with the last page number', async () => {
    await configured();
    const result = await h.run('arch findings get -p shop --page 4 --page-size 3 --format text');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('past the last page (3)');
    expect(result.stdout).toContain('--page 3');
  });

  it('renders readable typed details instead of raw JSON', async () => {
    await configured();
    const result = await h.run('arch findings get -p shop --format text');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('app:web -> app:db (disallowedDependency, 4 dependencies)');
    expect(result.stdout).toContain('app:web (misplacedComponent, 3 components)');
    expect(result.stdout).toContain('a, b (2 nodes)');
    expect(result.stdout).toContain('large (40 leaf artifacts)');
    expect(result.stdout).toContain('util (3 fragments)');
    expect(result.stdout).not.toContain('details: {');
  });

  it.each([true, false])(
    'skips future values but preserves backend totals on Cloud=%s',
    async (cloud) => {
      await configured(cloud, (api) =>
        api.withStatus(
          'project-findings',
          200,
          JSON.stringify({
            findings: [
              findings[0],
              { ...findings[0], type: 'futureFinding' },
              { ...findings[0], language: 'futureLanguage' },
              { ...findings[0], details: { reason: 'futureReason', nodeKey: 'app:web' } },
            ],
            page: { pageIndex: 1, pageSize: 50, total: 4 },
          }),
          'GET',
        ),
      );
      const result = await h.run('arch findings get -p shop --format json');
      if (!cloud) {
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          'The sonar architecture command requires a SonarQube Cloud connection.',
        );
        return;
      }
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        project: 'shop',
        findings: [findings[0]],
        page: { pageIndex: 1, pageSize: 50, total: 4 },
        skippedFindings: 3,
      });
    },
  );

  it('reports unsupported rows without claiming the project has no findings', async () => {
    await configured(true, (api) =>
      api.withStatus(
        'project-findings',
        200,
        JSON.stringify({
          findings: [{ ...findings[0], type: 'futureFinding' }],
          page: { pageIndex: 1, pageSize: 50, total: 1 },
        }),
        'GET',
      ),
    );
    const result = await h.run('arch findings get -p shop --format text');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Skipped 1 finding');
    expect(result.stdout).toContain('unsupported type, language or reason');
    expect(result.stdout).not.toContain('No findings');
    expect(result.stdout).not.toContain('past the last page');
  });
  for (const cloud of [true, false]) {
    it.each([
      ['--type structuralDeviation', { ...findings[0], type: 'futureType' }],
      ['--language java', { ...findings[0], language: 'futureLanguage' }],
      ['--category flaw', { ...findings[0], type: 'futureType' }],
      ['--type structuralDeviation', { ...findings[2], details: { reason: 'futureReason' } }],
    ])(
      `rejects raw filter mismatches before skipping unsupported rows on Cloud=${cloud}: %s`,
      async (filters, row) => {
        const server = await configured(cloud, (api) =>
          api.withStatus(
            'project-findings',
            200,
            JSON.stringify({ findings: [row], page: { pageIndex: 1, pageSize: 50, total: 1 } }),
            'GET',
          ),
        );
        const result = await h.run(`arch findings get -p shop ${filters} --format json`);
        if (!cloud) {
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain(
            'The sonar architecture command requires a SonarQube Cloud connection.',
          );
          return;
        }
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('outside the requested filters');
        expect(requests(server)).toHaveLength(1);
      },
    );

    it.each([
      ['--category deviation --language java', { ...findings[0], type: 'futureType' }],
      [
        '--type structuralDeviation --language java',
        { ...findings[0], details: { reason: 'futureReason' } },
      ],
    ])(
      `keeps future-value skipping when raw fields match active filters on Cloud=${cloud}: %s`,
      async (filters, row) => {
        await configured(cloud, (api) =>
          api.withStatus(
            'project-findings',
            200,
            JSON.stringify({ findings: [row], page: { pageIndex: 1, pageSize: 50, total: 1 } }),
            'GET',
          ),
        );
        const result = await h.run(`arch findings get -p shop ${filters} --format json`);
        if (!cloud) {
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain(
            'The sonar architecture command requires a SonarQube Cloud connection.',
          );
          return;
        }
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          findings: [],
          skippedFindings: 1,
          page: { pageIndex: 1, pageSize: 50, total: 1 },
        });
      },
    );
  }
});

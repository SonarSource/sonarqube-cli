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
      .withAuthToken('findings-token')
      .withProject('shop', (p) => p.withArchitecture(configure));
    if (cloud) builder.asSonarCloud();
    const server = await builder.start();
    h.withAuth(server.recordedAuthServerUrl(), 'findings-token', cloud ? 'my-org' : undefined);
    return server;
  }
  const requests = (server: Awaited<ReturnType<typeof configured>>) =>
    server.getRecordedRequests().filter((r) => r.path.includes('project-findings'));

  it.each([true, false])(
    'uses organization and analyzed branch on Cloud=%s without project UUID lookup',
    async (cloud) => {
      const server = await configured(cloud);
      const result = await h.run('arch findings get -p shop --format json');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        project: 'shop',
        findings,
        page: { pageIndex: 1, pageSize: 50, total: 8 },
      });
      const [request] = requests(server);
      expect(request.path).toBe(
        cloud ? '/architecture/project-findings' : '/api/v2/architecture/project-findings',
      );
      expect(request.query).toMatchObject({
        branchId: 'shop-branch-id',
        pageIndex: '1',
        pageSize: '50',
      });
      expect(request.query.organizationId).toBe(
        cloud ? 'my-org-uuid-v4' : '00000000-0000-4000-0000-000000000000',
      );
      expect(request.query.projectId).toBeUndefined();
      expect(request.query.language).toBeUndefined();
      expect(
        server.getRecordedRequests().some((r) => r.path === '/api/v2/components/projects'),
      ).toBe(false);
      expect(request.method).toBe('GET');
    },
  );
  it.each(['deviation', 'flaw', 'smell'])('filters category %s', async (category) => {
    const server = await configured();
    const result = await h.run(`arch findings get -p shop --category ${category} --format json`);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).findings).toEqual(
      findings.filter((f) => f.category === category),
    );
    expect(requests(server)[0].query.category).toBe(category);
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
    expect(JSON.parse(none.stdout).page.total).toBe(0);
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
    { ...findings[0], type: 'unknown' },
    { ...findings[0], category: 'DEVIATION' },
    { ...findings[0], category: 'flaw' },
    { ...findings[0], language: 'unknown' },
    { ...findings[0], details: null },
    { ...findings[0], files: [null] },
    { ...findings[0], details: { reason: 'unknown', nodeKey: 'a' } },
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
  });
  it.each([401, 403, 404, 500])('reports backend error %d without fallback', async (status) => {
    const server = await configured(true, (api) =>
      api.withStatus('project-findings', status, '{"message":"Unavailable"}', 'GET'),
    );
    const result = await h.run('arch findings get -p shop');
    expect(result.exitCode).not.toBe(0);
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
});

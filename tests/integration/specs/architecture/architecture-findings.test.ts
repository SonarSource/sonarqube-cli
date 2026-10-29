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

// Integration tests for architecture findings reads on the public architecture API

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { ProjectFinding } from '@/commands/architecture/_common/findings.ts';

import { TestHarness } from '../../harness';
import type { FakeArchitecture } from '../../harness/fake-architecture';

const findings: ProjectFinding[] = [
  {
    id: 'finding-1',
    projectId: 'shop-branch-id',
    category: 'DEVIATION',
    message: 'app:web depends on app:db',
    components: ['app:web', 'app:db'],
    relationships: [{ from: 'app:web', to: 'app:db' }],
    constraint: 'web must not depend on db',
  },
  { id: 'finding-2', projectId: 'shop-branch-id', category: 'FLAW', message: 'Cycle in app' },
  {
    id: 'finding-3',
    projectId: 'shop-branch-id',
    category: 'SMELL',
    measures: { fanIn: 42 },
  },
];

describe('public architecture findings', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await TestHarness.create();
  });
  afterEach(async () => {
    await h.dispose();
  });

  async function configured(configure: (api: FakeArchitecture) => void = () => {}) {
    const server = await h
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('findings-token')
      .withProject('shop', (project) => project.withArchitecture(configure))
      .start();
    h.withAuth(server.recordedAuthServerUrl(), 'findings-token', 'my-org');
    return server;
  }
  const findingRequests = (server: Awaited<ReturnType<typeof configured>>) =>
    server.getRecordedRequests().filter((r) => r.path.includes('project-findings'));

  it.each(['DEVIATION', 'FLAW', 'SMELL'])('filters by category %s', async (category) => {
    const server = await configured((api) => api.withFindings(findings));
    const read = await h.run(`arch findings get -p shop --category ${category} --format json`);
    expect(read.exitCode).toBe(0);
    const result = JSON.parse(read.stdout);
    expect(result.findings).toEqual(findings.filter((item) => item.category === category));
    expect(findingRequests(server)[0].query).toMatchObject({
      projectId: 'shop-branch-id',
      category,
    });
  });

  it('pages through all categories and tells how to continue', async () => {
    const server = await configured((api) => api.withFindings(findings));
    const first = await h.run('arch findings get -p shop --page-size 2 --format text');
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('Page 1: 2 of 3 findings. Use --page to continue.');
    expect(first.stdout).toContain('finding-1: DEVIATION app:web depends on app:db');
    const last = await h.run('arch findings get -p shop --page 2 --page-size 2 --format json');
    expect(JSON.parse(last.stdout)).toEqual({
      project: 'shop',
      findings: [findings[2]],
      page: { pageIndex: 2, pageSize: 2, total: 3 },
    });
    expect(findingRequests(server)[0].query.category).toBeUndefined();
  });

  it('reads one finding with its details', async () => {
    await configured((api) => api.withFindings(findings));
    const json = await h.run('arch findings get -p shop --id finding-1 --format json');
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ project: 'shop', finding: findings[0] });
    const text = await h.run('arch findings get -p shop --id finding-1 --format text');
    expect(text.stdout).toContain('finding-1: DEVIATION app:web depends on app:db');
    expect(text.stdout).toContain('  relationships: [{"from":"app:web","to":"app:db"}]');
    expect(text.stdout).toContain('  constraint: "web must not depend on db"');
  });

  it('explains an empty result without suggesting another page', async () => {
    await configured();
    const read = await h.run('arch findings get -p shop --format text');
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain(
      'No findings are visible. Check project access and whether the project has been analyzed.',
    );
    expect(read.stdout).toContain('Page 1: 0 of 0 findings.');
    expect(read.stdout).not.toContain('Use --page');
  });

  it('reports an unknown finding id', async () => {
    await configured((api) => api.withFindings(findings));
    const result = await h.run('arch findings get -p shop --id missing');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Finding missing was not found');
  });

  it('rejects an unsupported category before requesting findings', async () => {
    const server = await configured();
    const result = await h.run('arch findings get -p shop --category COVERAGE');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('DEVIATION, FLAW, SMELL');
    expect(findingRequests(server)).toHaveLength(0);
  });

  it.each([
    ['a different project', { projectId: 'other-branch-id' }],
    ['a different id', { id: 'finding-2' }],
  ])('rejects a single finding from %s', async (_, change) => {
    await configured((api) =>
      api
        .withFindings(findings)
        .withStatus('project-findings', 200, JSON.stringify({ ...findings[0], ...change }), 'GET'),
    );
    const result = await h.run('arch findings get -p shop --id finding-1');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('different id or project');
  });

  it('drops fields that are not part of the finding contract', async () => {
    await configured((api) =>
      api.withFindings([{ ...findings[1], unexpected: 'value' } as ProjectFinding]),
    );
    const result = await h.run('arch findings get -p shop --id finding-2 --format json');
    expect(JSON.parse(result.stdout).finding).toEqual(findings[1]);
  });

  it('rejects a path-like finding id before requesting it', async () => {
    const server = await configured();
    const result = await h.run('arch findings get -p shop --id ..');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Finding id must be a nonempty id');
    expect(findingRequests(server)).toHaveLength(0);
  });

  it.each(['--page 1', '--page-size 5', '--category FLAW'])(
    'refuses %s together with an explicit id',
    async (option) => {
      const server = await configured();
      const result = await h.run(`arch findings get -p shop --id finding-1 ${option}`);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Use either --id or --category and pagination');
      expect(findingRequests(server)).toHaveLength(0);
    },
  );

  it.each([0, 1001])('rejects page size %d before requesting findings', async (size) => {
    const server = await configured();
    const result = await h.run(`arch findings get -p shop --page-size ${size}`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('page size must be between 1 and 1000');
    expect(findingRequests(server)).toHaveLength(0);
  });

  it.each([
    ['an incomplete page', '{"projectFindings":[]}'],
    [
      'another project',
      '{"projectFindings":[{"id":"x","projectId":"other","category":"FLAW"}],"page":{"pageIndex":1,"pageSize":50,"total":1}}',
    ],
    [
      'a non-numeric measure',
      '{"projectFindings":[{"id":"x","projectId":"shop-branch-id","category":"FLAW","measures":{"m":"text"}}],"page":{"pageIndex":1,"pageSize":50,"total":1}}',
    ],
    [
      'duplicate ids',
      '{"projectFindings":[{"id":"x","projectId":"shop-branch-id","category":"FLAW"},{"id":"x","projectId":"shop-branch-id","category":"FLAW"}],"page":{"pageIndex":1,"pageSize":50,"total":2}}',
    ],
    [
      'an unsupported category',
      '{"projectFindings":[{"id":"x","projectId":"p","category":"X"}],"page":{"pageIndex":1,"pageSize":50,"total":1}}',
    ],
  ])('rejects %s from the server', async (_, body) => {
    await configured((api) => api.withStatus('project-findings', 200, body, 'GET'));
    const result = await h.run('arch findings get -p shop');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(
      /Invalid public findings page|unsupported category|different project|duplicate ids|non-numeric measure/,
    );
  });

  it.each([
    [403, "refused access to 'shop' (HTTP 403)"],
    [404, "Project 'shop' or its architecture was not found"],
  ])('explains HTTP %d', async (status, message) => {
    await configured((api) =>
      api.withStatus('project-findings', status, '{"message":"Access denied"}', 'GET'),
    );
    const result = await h.run('arch findings get -p shop');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it('explains that findings are not available on SonarQube Server yet', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('findings-token')
      .withProject('shop', (project) => project.withArchitecture(() => {}))
      .start();
    h.withAuth(server.recordedAuthServerUrl(), 'findings-token');
    const result = await h.run('arch findings get -p shop');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Architecture findings is not available yet on SonarQube Server',
    );
    expect(findingRequests(server)).toHaveLength(0);
  });
});

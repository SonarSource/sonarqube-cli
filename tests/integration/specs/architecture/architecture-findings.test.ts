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
      'array measures',
      '{"projectFindings":[{"id":"x","projectId":"shop-branch-id","category":"FLAW","measures":[1]}],"page":{"pageIndex":1,"pageSize":50,"total":1}}',
    ],
    [
      'non-string components',
      '{"projectFindings":[{"id":"x","projectId":"shop-branch-id","category":"FLAW","components":"a"}],"page":{"pageIndex":1,"pageSize":50,"total":1}}',
    ],
    [
      'invalid relationships',
      '{"projectFindings":[{"id":"x","projectId":"shop-branch-id","category":"FLAW","relationships":[{"x":1}]}],"page":{"pageIndex":1,"pageSize":50,"total":1}}',
    ],
    [
      'a non-string constraint',
      '{"projectFindings":[{"id":"x","projectId":"shop-branch-id","category":"FLAW","constraint":{}}],"page":{"pageIndex":1,"pageSize":50,"total":1}}',
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
      /Invalid public findings page|unsupported category|different project|duplicate ids|non-numeric measure|components must be strings|invalid relationships|constraint must be a string/,
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

  describe('on SonarQube Server', () => {
    const serverFindings = findings.map((item) => ({ ...item, projectId: 'shop-project-id' }));

    async function onServer(
      configure: (
        builder: ReturnType<TestHarness['newFakeServer']>,
      ) => ReturnType<TestHarness['newFakeServer']> = (builder) => builder,
    ) {
      const server = await configure(
        h
          .newFakeServer()
          .withAuthToken('findings-token')
          .withProject('shop', (project) =>
            project.withArchitecture((api) => api.withFindings(serverFindings)),
          ),
      ).start();
      h.withAuth(server.recordedAuthServerUrl(), 'findings-token');
      return server;
    }
    const lookups = (server: Awaited<ReturnType<typeof onServer>>) =>
      server.getRecordedRequests().filter((r) => r.path === '/api/v2/components/projects');

    it('lists findings with the project id from the public project lookup', async () => {
      const server = await onServer();
      const read = await h.run('arch findings get -p shop --category FLAW --format json');
      expect(read.exitCode).toBe(0);
      expect(JSON.parse(read.stdout).findings).toEqual([serverFindings[1]]);
      expect(lookups(server)[0].query).toMatchObject({ keys: 'shop', pageSize: '1' });
      const [request] = findingRequests(server);
      expect(request.path).toBe('/api/v2/architecture/project-findings');
      expect(request.query).toMatchObject({ projectId: 'shop-project-id', category: 'FLAW' });
    });

    it('reads one finding and checks it belongs to the resolved project', async () => {
      const server = await onServer();
      const read = await h.run('arch findings get -p shop --id finding-1 --format json');
      expect(read.exitCode).toBe(0);
      expect(JSON.parse(read.stdout).finding).toEqual(serverFindings[0]);
      expect(findingRequests(server)[0].path).toBe(
        '/api/v2/architecture/project-findings/finding-1',
      );
    });

    it.each([
      ['no match', { projects: [], page: { total: 0 } }],
      ['another key', { projects: [{ id: 'x', key: 'other' }], page: { total: 1 } }],
      ['a blank id', { projects: [{ id: ' ', key: 'shop' }], page: { total: 1 } }],
      ['a null body', null],
    ])('stops before reading findings when the lookup returns %s', async (_, body) => {
      const server = await onServer((builder) => builder.withProjectsLookupResponse(200, body));
      const result = await h.run('arch findings get -p shop');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Could not resolve project 'shop'");
      expect(findingRequests(server)).toHaveLength(0);
    });

    it('explains a Server without the public project lookup', async () => {
      const server = await onServer((builder) =>
        builder.withProjectsLookupResponse(404, { message: 'Not found' }),
      );
      const result = await h.run('arch findings get -p shop --id finding-1');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('does not expose the public project lookup');
      expect(findingRequests(server)).toHaveLength(0);
    });
  });
});

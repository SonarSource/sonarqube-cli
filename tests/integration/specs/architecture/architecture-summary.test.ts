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

import { findings } from '../../../fixtures/architecture/findings';
import { TestHarness } from '../../harness';
import type { FakeArchitecture } from '../../harness/fake-architecture';

describe('current architecture summary', () => {
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

  it('returns zero counts for an analyzed language without findings', async () => {
    await configured(true, (api) => api.withFindings([]).withAnalyzedLanguages(['java']));
    const result = await h.run('arch current get --summary -p shop --format json');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).summaries[0]).toEqual({
      language: 'java',
      deviations: { total: 0, structuralDeviation: 0, relationshipDeviation: 0 },
      flaws: { total: 0, tangle: 0, oversizedComponent: 0 },
      smells: { total: 0, weakTangle: 0, splitResponsibility: 0 },
    });
  });

  it('reports a missing summary endpoint', async () => {
    await configured(true, (api) => api.withStatus('project-summaries', 404));
    const result = await h.run('arch current get --summary -p shop --format json');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('404');
  });

  it('rejects a main branch without analysis for summary', async () => {
    const server = await h
      .newFakeServer()
      .withAuthToken('findings-token')
      .asSonarCloud()
      .withProject('shop', (p) =>
        p
          .withDefaultBranchName('main')
          .withUnanalyzedBranch('main')
          .withArchitecture((api) => api.withFindings([])),
      )
      .start();
    h.withAuth(server.recordedAuthServerUrl(), 'findings-token', 'my-org');
    const result = await h.run('arch current get --summary -p shop --format json');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Project 'shop' has no analyzed main branch.");
    expect(server.getRecordedRequests().some((r) => r.path.includes('project-summaries'))).toBe(
      false,
    );
  });

  it('reports skipped future-language summaries without claiming there are no findings', async () => {
    const future = {
      language: 'go',
      deviations: { total: 0, structuralDeviation: 0, relationshipDeviation: 0 },
      flaws: { total: 0, tangle: 0, oversizedComponent: 0 },
      smells: { total: 0, weakTangle: 0, splitResponsibility: 0 },
    };
    await configured(true, (api) =>
      api.withStatus('project-summaries', 200, JSON.stringify({ projectSummaries: [future] })),
    );
    const result = await h.run('arch current get --summary -p shop --format json');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      project: 'shop',
      summaries: [],
      skippedSummaries: 1,
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

  it('prints readable summary counts in text format', async () => {
    await configured();
    const result = await h.run('arch current get --summary -p shop --language java --format text');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('java:');
    expect(result.stdout).toContain(
      'deviations: 4 (structuralDeviation: 2, relationshipDeviation: 2)',
    );
    expect(result.stdout).not.toContain('{"language"');
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
});

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

import { describe, expect, it } from 'bun:test';

import type { ClassificationEntry } from '@/commands/admin/onboard-ci/gitlab/dry-run.ts';
import { computeDryRunResults } from '@/commands/admin/onboard-ci/gitlab/dry-run.ts';
import type {
  RepoClassification,
  RepoWithBranch,
} from '@/commands/admin/onboard-ci/gitlab/processor.ts';
import { SkipReason } from '@/commands/admin/onboard-ci/gitlab/types.ts';

function makeRepo(id: number, path: string): RepoWithBranch {
  return {
    id,
    name: path.split('/').at(-1) ?? path,
    path_with_namespace: path,
    default_branch: 'main',
    marked_for_deletion_at: null,
  };
}

function proceed(repo: RepoWithBranch, projectKey: string): ClassificationEntry {
  return {
    repo,
    classification: {
      outcome: 'proceed',
      ciFilePath: '.gitlab-ci.yml',
      existingCi: null,
      projectKey,
    } satisfies RepoClassification,
  };
}

function skip(
  repo: RepoWithBranch,
  reason: RepoClassification & { outcome: 'skip' },
): ClassificationEntry {
  return { repo, classification: reason };
}

describe('computeDryRunResults', () => {
  it('marks repo as would open MR when bound in SonarQube', () => {
    const repo = makeRepo(1, 'org/repo-one');
    const result = computeDryRunResults([proceed(repo, 'org_repo-one')], []);

    expect(result.wouldOpenMr).toHaveLength(1);
    expect(result.wouldOpenMr[0]).toEqual({
      repo: 'org/repo-one',
      projectKey: 'org_repo-one',
    });
    expect(result.wouldSkip).toHaveLength(0);
  });

  it('places skipped repos in wouldSkip with their reason', () => {
    const repo = makeRepo(3, 'org/jenkins-repo');
    const result = computeDryRunResults(
      [
        skip(repo, {
          outcome: 'skip',
          reason: SkipReason.OtherCiDetected,
          message: 'skipped (other CI detected)',
        }),
      ],
      [],
    );

    expect(result.wouldOpenMr).toHaveLength(0);
    expect(result.wouldSkip).toHaveLength(1);
    expect(result.wouldSkip[0]).toEqual({
      repo: 'org/jenkins-repo',
      reason: SkipReason.OtherCiDetected,
    });
  });

  it('places repos not in SonarQube in wouldSkip with NotInSonarQube reason', () => {
    const repo = makeRepo(4, 'org/unbound-repo');
    const result = computeDryRunResults(
      [skip(repo, { outcome: 'skip', reason: SkipReason.NotInSonarQube, message: '' })],
      [],
    );

    expect(result.wouldSkip).toHaveLength(1);
    expect(result.wouldSkip[0].reason).toBe(SkipReason.NotInSonarQube);
    expect(result.wouldOpenMr).toHaveLength(0);
  });

  it('handles a mix of proceed and skip classifications', () => {
    const bound = makeRepo(1, 'org/bound-repo');
    const jenkins = makeRepo(2, 'org/jenkins-repo');
    const unbound = makeRepo(3, 'org/unbound-repo');

    const result = computeDryRunResults(
      [
        proceed(bound, 'org_bound-repo'),
        skip(jenkins, { outcome: 'skip', reason: SkipReason.OtherCiDetected, message: '' }),
        skip(unbound, { outcome: 'skip', reason: SkipReason.NotInSonarQube, message: '' }),
      ],
      [],
    );

    expect(result.wouldOpenMr).toHaveLength(1);
    expect(result.wouldOpenMr[0].projectKey).toBe('org_bound-repo');
    expect(result.wouldSkip).toHaveLength(2);
  });

  it('ignores entries where classification failed (null)', () => {
    const repo = makeRepo(4, 'org/failed-repo');
    const result = computeDryRunResults([{ repo, classification: null }], []);

    expect(result.wouldOpenMr).toHaveLength(0);
    expect(result.wouldSkip).toHaveLength(0);
  });

  it('places failed repos in the failed bucket', () => {
    const repo = makeRepo(5, 'org/errored-repo');
    const failed = [{ repo: repo.path_with_namespace, error: 'GitLab API error 500' }];
    const result = computeDryRunResults([{ repo, classification: null }], failed);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toEqual({ repo: 'org/errored-repo', error: 'GitLab API error 500' });
    expect(result.wouldOpenMr).toHaveLength(0);
    expect(result.wouldSkip).toHaveLength(0);
  });

  it('includes failed repos in the total when mixed with successes', () => {
    const good = makeRepo(1, 'org/good-repo');
    const bad = makeRepo(2, 'org/bad-repo');
    const failed = [{ repo: bad.path_with_namespace, error: 'timeout' }];

    const result = computeDryRunResults(
      [proceed(good, 'org_good-repo'), { repo: bad, classification: null }],
      failed,
    );

    expect(result.wouldOpenMr).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].repo).toBe('org/bad-repo');
  });

  it('returns empty results for empty list', () => {
    const result = computeDryRunResults([], []);
    expect(result.wouldOpenMr).toHaveLength(0);
    expect(result.wouldSkip).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});

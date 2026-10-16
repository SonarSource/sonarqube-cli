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

import type {
  BoundProjectRequest,
  GitlabRepositoryResponse,
  ServerImportApiClient,
} from '@/commands/import/server/server-import-api.ts';
import { ServerBackend } from '@/commands/import/server-backend.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

const SERVER_URL = 'https://sonarqube.example.com';

function gitlabRepo(id: number, pathSlug: string, slug: string): GitlabRepositoryResponse {
  return { id, name: slug, slug, pathSlug };
}

function fakeApi(repositories: GitlabRepositoryResponse[]): {
  api: ServerImportApiClient;
  bound: BoundProjectRequest[];
} {
  const bound: BoundProjectRequest[] = [];
  const api = {
    listDopSettings: () => Promise.resolve([{ id: 'id-1', key: 'gitlab-main', type: 'gitlab' }]),
    checkPat: () => Promise.resolve('valid'),
    searchGitlabRepos: () => Promise.resolve({ repositories, total: repositories.length }),
    putBoundProject: (request: BoundProjectRequest) => {
      bound.push(request);
      return Promise.resolve({ newProjectCreated: true });
    },
  } as unknown as ServerImportApiClient;
  return { api, bound };
}

async function planFor(
  repositories: GitlabRepositoryResponse[],
  options: { repo?: string[]; all?: boolean },
) {
  const { api, bound } = fakeApi(repositories);
  const plan = await new ServerBackend(api, SERVER_URL).plan(
    { ...options, nonInteractive: true },
    new FakeConsole(),
  );
  return { plan, bound };
}

describe('ServerBackend', () => {
  describe('project key collisions', () => {
    const repositories = [gitlabRepo(1, 'group', 'sub_repo'), gitlabRepo(2, 'group/sub', 'repo')];

    it('refuses a repository whose key was already taken by another one in the run', async () => {
      const { plan, bound } = await planFor(repositories, {
        repo: ['group/sub_repo', 'group/sub/repo'],
      });
      if (plan.selection.kind !== 'batch') {
        throw new Error('expected a batch selection');
      }
      const [first, second] = plan.selection.repos;

      await plan.importRepo(first);
      const failure = await plan.importRepo(second).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CommandFailedError);
      expect((failure as CommandFailedError).message).toContain('group_sub_repo');
      expect(bound).toHaveLength(1);
      expect(bound[0].repositoryIdentifier).toBe('1');
    });

    it('still lets the same repository be imported twice', async () => {
      const { plan, bound } = await planFor(repositories, { repo: ['group/sub_repo'] });
      if (plan.selection.kind !== 'batch') {
        throw new Error('expected a batch selection');
      }
      const [only] = plan.selection.repos;

      await plan.importRepo(only);
      await plan.importRepo(only);

      expect(bound).toHaveLength(2);
    });
  });

  describe('selection hints', () => {
    it('does not mention an organization when a requested repository is not listed', async () => {
      const failure = await planFor([gitlabRepo(1, 'group', 'repo')], {
        repo: ['group/missing'],
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CommandFailedError);
      expect((failure as CommandFailedError).remediationHint).not.toMatch(/org/i);
    });

    it('does not mention an organization when the platform lists no repository', async () => {
      const failure = await planFor([], { all: true }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CommandFailedError);
      expect((failure as CommandFailedError).message).toContain('No repositories found');
      expect((failure as CommandFailedError).remediationHint).not.toMatch(/org/i);
    });
  });
});

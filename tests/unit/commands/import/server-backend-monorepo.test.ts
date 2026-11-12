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

const PROJECTS = [
  { projectKey: 'group_repo_api', projectName: 'API' },
  { projectKey: 'group_repo_web', projectName: 'Web' },
];

function setup(overrides: Partial<Record<string, unknown>> = {}, bound = false) {
  const repository: GitlabRepositoryResponse = {
    id: 1,
    name: 'repo',
    slug: 'repo',
    pathSlug: 'group',
    ...(bound ? { sqProjectKey: 'group_repo' } : {}),
  };
  const created: BoundProjectRequest[] = [];
  const api = {
    requireSupportedVersion: () => Promise.resolve(),
    listDopSettings: () => Promise.resolve([{ id: 'id-1', key: 'gitlab-main', type: 'gitlab' }]),
    checkPat: () => Promise.resolve('valid'),
    searchGitlabRepos: () => Promise.resolve({ repositories: [repository], total: 1 }),
    lookupProject: () => Promise.resolve('missing'),
    createBoundProject: (request: BoundProjectRequest) => {
      created.push(request);
      return Promise.resolve();
    },
    ...overrides,
  } as unknown as ServerImportApiClient;
  return { api, created };
}

async function planFor(api: ServerImportApiClient) {
  return new ServerBackend(api, 'https://sonarqube.example.com').plan(
    { repo: ['group/repo'], monorepo: 'group/repo', nonInteractive: true },
    new FakeConsole(),
  );
}

async function importAll(api: ServerImportApiClient) {
  const plan = await planFor(api);
  if (plan.selection.kind !== 'batch') throw new Error('expected a batch selection');
  const reports: Array<[string, string, string | undefined]> = [];
  await plan.importMonorepo(plan.selection.repos[0], PROJECTS, (k, s, d) =>
    reports.push([k, s, d]),
  );
  return reports;
}

describe('ServerBackend.importMonorepo', () => {
  it('creates each project with the monorepo flag, bound to the same repository', async () => {
    const { api, created } = setup();
    const reports = await importAll(api);

    expect(created).toHaveLength(2);
    expect(created.map((request) => request.monorepo)).toEqual([true, true]);
    expect(created.map((request) => request.projectKey)).toEqual([
      'group_repo_api',
      'group_repo_web',
    ]);
    expect(new Set(created.map((request) => request.repositoryIdentifier)).size).toBe(1);
    expect(reports.filter(([, status]) => status === 'done')).toHaveLength(2);
  });

  it('keeps going after one project fails, and reports the failure', async () => {
    const { api, created } = setup({
      createBoundProject: (request: BoundProjectRequest) => {
        if (request.projectKey === 'group_repo_api') {
          return Promise.reject(new Error('Enterprise Edition required'));
        }
        created.push(request);
        return Promise.resolve();
      },
    });
    const reports = await importAll(api);

    const api_ = reports.find(([key, status]) => key === 'group_repo_api' && status === 'failed');
    expect(api_?.[2]).toContain('Enterprise Edition required');
    expect(reports).toContainEqual(['group_repo_web', 'done', undefined]);
  });

  it('fails a key that belongs to a project not bound to this repository', async () => {
    const { api, created } = setup({
      lookupProject: () => Promise.resolve('found'),
      findProjectBinding: () => Promise.resolve(undefined),
    });
    const reports = await importAll(api);

    expect(created).toHaveLength(0);
    expect(reports.filter(([, status]) => status === 'failed')).toHaveLength(2);
    expect(reports[reports.length - 1][2]).toContain('already exists');
  });

  it('refuses a repository that is already imported, creating nothing', async () => {
    const { api, created } = setup({}, true);
    const failure = await planFor(api).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CommandFailedError);
    expect((failure as CommandFailedError).message).toContain('already been imported');
    expect(created).toHaveLength(0);
  });
});

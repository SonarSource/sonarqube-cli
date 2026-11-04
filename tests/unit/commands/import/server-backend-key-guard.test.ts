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

import { describe, expect, it, mock } from 'bun:test';

import type {
  ProjectBindingResponse,
  ServerImportApiClient,
} from '@/commands/import/server/server-import-api.ts';
import { ServerBackend } from '@/commands/import/server-backend.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

type Lookup = 'found' | 'missing' | 'hidden';

type GitlabRepo = { id: number; name: string; slug: string; pathSlug: string };

const DEFAULT_REPOS: GitlabRepo[] = [
  { id: 1, name: 'repo-a', slug: 'repo-a', pathSlug: 'group' },
  { id: 2, name: 'repo-b', slug: 'repo-b', pathSlug: 'group' },
];

async function importAll(
  lookups: Record<string, Lookup>,
  bindings: ProjectBindingResponse[] = [],
  repos: GitlabRepo[] = DEFAULT_REPOS,
) {
  const createBoundProject = mock(() => Promise.resolve({ newProjectCreated: true }));
  const api = {
    requireSupportedVersion: () => Promise.resolve(),
    listDopSettings: () =>
      Promise.resolve([{ id: 'gl-id', key: 'my-gitlab', type: 'gitlab' as const }]),
    checkPat: () => Promise.resolve('valid' as const),
    searchGitlabRepos: () =>
      Promise.resolve({
        repositories: repos,
        total: repos.length,
      }),
    lookupProject: (key: string) => Promise.resolve(lookups[key] ?? 'missing'),
    findProjectBinding: (
      _settingId: string,
      _repository: string,
      matches: (binding: ProjectBindingResponse) => boolean,
    ) => Promise.resolve(bindings.find(matches)),
    createBoundProject,
  } as unknown as ServerImportApiClient;
  const backend = new ServerBackend(api, 'https://sonarqube.example.com');

  const plan = await backend.plan(
    { repo: repos.map((r) => `${r.pathSlug}/${r.slug}`), nonInteractive: true },
    new FakeConsole(),
  );
  if (plan.selection.kind !== 'batch') throw new Error('expected a batch selection');
  const outcomes = await Promise.allSettled(plan.selection.repos.map((r) => plan.importRepo(r)));
  return { outcomes, createBoundProject };
}

describe('ServerBackend project key guard', () => {
  it('does not create a repository whose key belongs to an unrelated project, and still imports the others', async () => {
    const { outcomes, createBoundProject } = await importAll({ 'group_repo-a': 'found' });

    expect(outcomes[0]).toMatchObject({
      status: 'rejected',
      reason: {
        message:
          "A project with key 'group_repo-a' already exists and is not bound to group/repo-a; the CLI did not change it.",
      },
    });
    expect(outcomes[1].status).toBe('fulfilled');
    expect(createBoundProject).toHaveBeenCalledTimes(1);
    expect(createBoundProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectKey: 'group_repo-b', repositoryIdentifier: '2' }),
    );
  });

  it('does not create a repository whose key belongs to a project the caller cannot see', async () => {
    const { outcomes, createBoundProject } = await importAll({
      'group_repo-a': 'hidden',
      'group_repo-b': 'hidden',
    });

    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    expect(createBoundProject).not.toHaveBeenCalled();
  });

  it('does not mutate a project whose binding already matches', async () => {
    const { outcomes, createBoundProject } = await importAll({ 'group_repo-a': 'found' }, [
      {
        projectKey: 'group_repo-a',
        devOpsPlatformSettingId: 'gl-id',
        repository: '1',
      },
    ]);

    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(createBoundProject).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toMatchObject({
      status: 'fulfilled',
      value: { detail: 'project already exists with matching binding' },
    });
  });

  it('refuses a second repository whose derived key collides with one imported in the same run', async () => {
    const { outcomes, createBoundProject } = await importAll(
      {},
      [],
      [
        { id: 1, name: 'my_repo', slug: 'my_repo', pathSlug: 'acme' },
        { id: 2, name: 'repo', slug: 'repo', pathSlug: 'acme_my' },
      ],
    );

    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: {
        message:
          "Repository 'acme_my/repo' would get the project key 'acme_my_repo', already used by another repository in this run.",
      },
    });
    expect(createBoundProject).toHaveBeenCalledTimes(1);
    expect(createBoundProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectKey: 'acme_my_repo', repositoryIdentifier: '1' }),
    );
  });
});

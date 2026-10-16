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

async function importAll(lookups: Record<string, Lookup>, bindings: ProjectBindingResponse[] = []) {
  const putBoundProject = mock(() => Promise.resolve({ newProjectCreated: true }));
  const api = {
    listDopSettings: () =>
      Promise.resolve([{ id: 'gl-id', key: 'my-gitlab', type: 'gitlab' as const }]),
    checkPat: () => Promise.resolve('valid' as const),
    searchGitlabRepos: () =>
      Promise.resolve({
        repositories: [
          { id: 1, name: 'repo-a', slug: 'repo-a', pathSlug: 'group' },
          { id: 2, name: 'repo-b', slug: 'repo-b', pathSlug: 'group' },
        ],
        total: 2,
      }),
    lookupProject: (key: string) => Promise.resolve(lookups[key] ?? 'missing'),
    searchProjectBindings: () => Promise.resolve(bindings),
    putBoundProject,
  } as unknown as ServerImportApiClient;
  const backend = new ServerBackend(api, 'https://sonarqube.example.com');

  const plan = await backend.plan(
    { repo: ['group/repo-a', 'group/repo-b'], nonInteractive: true },
    new FakeConsole(),
  );
  if (plan.selection.kind !== 'batch') throw new Error('expected a batch selection');
  const outcomes = await Promise.allSettled(plan.selection.repos.map((r) => plan.importRepo(r)));
  return { outcomes, putBoundProject };
}

describe('ServerBackend project key guard', () => {
  it('does not PUT a repository whose key belongs to an unrelated project, and still imports the others', async () => {
    const { outcomes, putBoundProject } = await importAll({ 'group_repo-a': 'found' });

    expect(outcomes[0]).toMatchObject({
      status: 'rejected',
      reason: {
        message:
          "A project with key 'group_repo-a' already exists and is not bound to group/repo-a; the CLI did not change it.",
      },
    });
    expect(outcomes[1].status).toBe('fulfilled');
    expect(putBoundProject).toHaveBeenCalledTimes(1);
    expect(putBoundProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectKey: 'group_repo-b', repositoryIdentifier: '2' }),
    );
  });

  it('does not PUT a repository whose key belongs to a project the caller cannot see', async () => {
    const { outcomes, putBoundProject } = await importAll({
      'group_repo-a': 'hidden',
      'group_repo-b': 'hidden',
    });

    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    expect(putBoundProject).not.toHaveBeenCalled();
  });

  it('PUTs a repository again when its key is already bound to it', async () => {
    const { outcomes, putBoundProject } = await importAll({ 'group_repo-a': 'found' }, [
      {
        projectKey: 'group_repo-a',
        devOpsPlatformSettingId: 'gl-id',
        repository: '1',
      },
    ]);

    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(putBoundProject).toHaveBeenCalledTimes(2);
  });
});

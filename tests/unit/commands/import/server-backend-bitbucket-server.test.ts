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

import type { ServerImportApiClient } from '@/commands/import/server/server-import-api.ts';
import { ServerBackend } from '@/commands/import/server-backend.ts';
import type { Console } from '@/core/ui/console.ts';

describe('ServerBackend importing a Bitbucket Server repository', () => {
  it('puts the bound project with the repository slug and the Bitbucket project key', async () => {
    const putBoundProject = mock(() => Promise.resolve({ newProjectCreated: true }));
    const api = {
      requireSupportedVersion: () => Promise.resolve(),
      listDopSettings: () =>
        Promise.resolve([{ id: 'bb-id', key: 'my-bbs', type: 'bitbucket' as const }]),
      checkPat: () => Promise.resolve('valid' as const),
      listBitbucketServerProjects: () =>
        Promise.resolve({ projects: [{ key: 'PRJ', name: 'Project' }], nextStart: undefined }),
      searchBitbucketServerRepos: () =>
        Promise.resolve({
          repositories: [{ id: 5, slug: 'my-repo', name: 'My Repo', projectKey: 'PRJ' }],
          nextStart: undefined,
        }),
      lookupProject: () => Promise.resolve('missing' as const),
      putBoundProject,
    } as unknown as ServerImportApiClient;
    const backend = new ServerBackend(api, 'https://sonarqube.example.com');

    const plan = await backend.plan({ repo: ['PRJ/my-repo'], nonInteractive: true }, {
      info: () => undefined,
    } as unknown as Console);
    if (plan.selection.kind !== 'batch') throw new Error('expected a batch selection');
    await plan.importRepo(plan.selection.repos[0]);

    expect(putBoundProject).toHaveBeenCalledWith({
      projectKey: 'PRJ_my-repo',
      projectName: 'My Repo',
      devOpsPlatformSettingId: 'bb-id',
      repositoryIdentifier: 'my-repo',
      projectIdentifier: 'PRJ',
    });
  });
});

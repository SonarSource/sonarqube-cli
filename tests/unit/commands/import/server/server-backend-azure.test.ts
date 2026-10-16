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

import { FakeConsole } from '../../../../_common/fake-console.ts';

describe('ServerBackend importing from Azure DevOps', () => {
  it('sends the repository name and its Azure DevOps project name to the server', async () => {
    const putBoundProject = mock(() => Promise.resolve({ newProjectCreated: true }));
    const api = {
      requireSupportedVersion: () => Promise.resolve(),
      listDopSettings: () =>
        Promise.resolve([{ id: 'az-id', key: 'my-azure', type: 'azure' as const }]),
      checkPat: () => Promise.resolve('valid' as const),
      listAzureProjects: () => Promise.resolve([{ name: 'My Project' }]),
      searchAzureRepos: () => Promise.resolve([{ name: 'web-app', projectName: 'My Project' }]),
      lookupProject: () => Promise.resolve('missing' as const),
      putBoundProject,
    } as unknown as ServerImportApiClient;

    const plan = await new ServerBackend(api, 'https://sonarqube.example.com').plan(
      { all: true, nonInteractive: true },
      new FakeConsole(),
    );
    if (plan.selection.kind !== 'streaming') throw new Error('expected a streaming selection');
    const [listed] = plan.selection.collection.eligibleRepos;
    await plan.importRepo(plan.toResolvedRepo(listed));

    expect(putBoundProject).toHaveBeenCalledWith({
      projectKey: 'My_Project_web-app',
      projectName: 'web-app',
      devOpsPlatformSettingId: 'az-id',
      repositoryIdentifier: 'web-app',
      projectIdentifier: 'My Project',
    });
  });
});

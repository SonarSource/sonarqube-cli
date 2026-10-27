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
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { BadRequestError } from '@/core/server/errors.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

describe('ServerBackend importing from Azure DevOps', () => {
  it('sends the repository name and its Azure DevOps project name to the server', async () => {
    const putBoundProject = mock(() => Promise.resolve({ newProjectCreated: true }));
    const api = {
      requireSupportedVersion: () => Promise.resolve(),
      listDopSettings: () =>
        Promise.resolve([{ id: 'az-id', key: 'my-azure', type: 'azure' as const }]),
      checkPat: () => Promise.resolve('valid' as const),
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

  describe('when Azure DevOps lists nothing', () => {
    const URL = 'https://sonarqube.example.com';

    async function planFailure(api: object): Promise<CommandFailedError> {
      const stubbed = { requireSupportedVersion: () => Promise.resolve(), ...api };
      const error = await new ServerBackend(stubbed as unknown as ServerImportApiClient, URL)
        .plan({ all: true, nonInteractive: true }, new FakeConsole())
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(CommandFailedError);
      return error as CommandFailedError;
    }

    it('ends with the actionable error and the reconnect URL instead of "No repositories found"', async () => {
      const error = await planFailure({
        listDopSettings: () =>
          Promise.resolve([{ id: 'az-id', key: 'my-azure', type: 'azure' as const }]),
        checkPat: () => Promise.resolve('valid' as const),
        searchAzureRepos: () => Promise.resolve([]),
      });

      expect(error.message).toContain('Azure DevOps did not return any repository');
      expect(error.exitCode).toBe(1);
      expect(error.remediationHint).toContain(`${URL}/projects/create?mode=azure&resetPat=1`);
    });

    it('maps the server not being able to read Azure DevOps to the same error', async () => {
      const error = await planFailure({
        listDopSettings: () =>
          Promise.resolve([{ id: 'az-id', key: 'my-azure', type: 'azure' as const }]),
        checkPat: () => Promise.resolve('valid' as const),
        searchAzureRepos: () =>
          Promise.reject(new BadRequestError('Unable to contact Azure DevOps server: boom')),
      });

      expect(error.message).toContain('Azure DevOps did not return any repository');
      expect(error.remediationHint).toContain('resetPat=1');
    });

    it('keeps "No repositories found" for the other platforms', async () => {
      const error = await planFailure({
        listDopSettings: () =>
          Promise.resolve([{ id: 'gl-id', key: 'my-gitlab', type: 'gitlab' as const }]),
        checkPat: () => Promise.resolve('valid' as const),
        searchGitlabRepos: () => Promise.resolve({ repositories: [], total: 0 }),
      });

      expect(error.message).toContain('No repositories found');
    });
  });
});

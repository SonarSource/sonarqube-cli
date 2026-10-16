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

import { assertProjectKeyUsable } from '@/commands/import/server/key-guard.ts';
import type {
  DopSetting,
  ProjectBindingResponse,
} from '@/commands/import/server/server-import-api.ts';
import type { ServerRepository } from '@/commands/import/server/server-repository.ts';
import { ServerError } from '@/core/server/errors.ts';

const GITLAB: DopSetting = { id: 'gl-id', key: 'my-gitlab', type: 'gitlab' };
const KEY = 'group_repo';

function repository(overrides: Partial<ServerRepository> = {}): ServerRepository {
  return {
    id: '42',
    name: 'repo',
    slug: 'group/repo',
    repositoryIdentifier: '42',
    ...overrides,
  };
}

function binding(overrides: Partial<ProjectBindingResponse> = {}): ProjectBindingResponse {
  return { projectKey: KEY, devOpsPlatformSettingId: 'gl-id', repository: '42', ...overrides };
}

function apiWith(lookup: 'found' | 'missing' | 'hidden', bindings: ProjectBindingResponse[] = []) {
  return {
    lookupProject: mock(() => Promise.resolve(lookup)),
    searchProjectBindings: mock(() => Promise.resolve(bindings)),
  };
}

const failureOf = (...args: Parameters<typeof assertProjectKeyUsable>) =>
  assertProjectKeyUsable(...args).then(
    () => undefined,
    (error: unknown) => error,
  );

const refusal = {
  message: `A project with key '${KEY}' already exists and is not bound to group/repo; the CLI did not change it.`,
};

describe('assertProjectKeyUsable', () => {
  it('lets the import go ahead when no project has the key, without looking at bindings', async () => {
    const api = apiWith('missing');
    await assertProjectKeyUsable(api, GITLAB, repository(), KEY);
    expect(api.lookupProject).toHaveBeenCalledWith(KEY);
    expect(api.searchProjectBindings).not.toHaveBeenCalled();
  });

  it('lets a project bound to this repository on this setting go ahead', async () => {
    const api = apiWith('found', [binding()]);
    await assertProjectKeyUsable(api, GITLAB, repository(), KEY);
    expect(api.searchProjectBindings).toHaveBeenCalledWith('gl-id', '42');
  });

  it('refuses a project bound to another repository', async () => {
    const api = apiWith('found', [binding({ repository: '99' })]);
    expect(await failureOf(api, GITLAB, repository(), KEY)).toMatchObject(refusal);
  });

  it('refuses a project bound to the same repository id on another setting', async () => {
    const api = apiWith('found', [binding({ devOpsPlatformSettingId: 'other-id' })]);
    expect(await failureOf(api, GITLAB, repository(), KEY)).toMatchObject(refusal);
  });

  it('refuses a binding whose project is another one than the derived key', async () => {
    const api = apiWith('found', [binding({ projectKey: 'other_key' })]);
    expect(await failureOf(api, GITLAB, repository(), KEY)).toMatchObject(refusal);
  });

  it('refuses an existing project that has no binding', async () => {
    const api = apiWith('found', []);
    expect(await failureOf(api, GITLAB, repository(), KEY)).toMatchObject(refusal);
  });

  it('refuses a project the caller cannot see, without looking at bindings', async () => {
    const api = apiWith('hidden');
    expect(await failureOf(api, GITLAB, repository(), KEY)).toMatchObject(refusal);
    expect(api.searchProjectBindings).not.toHaveBeenCalled();
  });

  it('compares repository identifiers case-insensitively', async () => {
    const api = apiWith('found', [binding({ repository: 'Acme/Repo' })]);
    const github: DopSetting = { id: 'gl-id', key: 'gh', type: 'github' };
    await assertProjectKeyUsable(
      api,
      github,
      repository({ repositoryIdentifier: 'acme/repo' }),
      KEY,
    );
  });

  describe('platforms that bind two identifiers', () => {
    it('matches Azure DevOps on repository name and project name', async () => {
      const azure: DopSetting = { id: 'gl-id', key: 'az', type: 'azure' };
      const azureRepo = repository({ repositoryIdentifier: 'repo', projectIdentifier: 'Proj' });
      await assertProjectKeyUsable(
        apiWith('found', [binding({ repository: 'repo', slug: 'Proj' })]),
        azure,
        azureRepo,
        KEY,
      );
      expect(
        await failureOf(
          apiWith('found', [binding({ repository: 'repo', slug: 'Other' })]),
          azure,
          azureRepo,
          KEY,
        ),
      ).toMatchObject(refusal);
    });

    it('matches Bitbucket Server on project key and repository slug', async () => {
      const bitbucket: DopSetting = { id: 'gl-id', key: 'bb', type: 'bitbucket' };
      const bbRepo = repository({ repositoryIdentifier: 'my-repo', projectIdentifier: 'PRJ' });
      await assertProjectKeyUsable(
        apiWith('found', [binding({ repository: 'PRJ', slug: 'my-repo' })]),
        bitbucket,
        bbRepo,
        KEY,
      );
      expect(
        await failureOf(
          apiWith('found', [binding({ repository: 'my-repo', slug: 'PRJ' })]),
          bitbucket,
          bbRepo,
          KEY,
        ),
      ).toMatchObject(refusal);
    });
  });

  describe('when the lookup itself fails', () => {
    it('fails the repository with the server message if the existence check fails', async () => {
      const api = {
        lookupProject: mock(() => Promise.reject(new ServerError(500, 'database down'))),
        searchProjectBindings: mock(() => Promise.resolve([])),
      };
      expect(await failureOf(api, GITLAB, repository(), KEY)).toMatchObject({
        message: `Could not check whether a project with key '${KEY}' already exists: database down`,
      });
    });

    it('fails the repository if the bindings search fails', async () => {
      const api = {
        lookupProject: mock(() => Promise.resolve('found' as const)),
        searchProjectBindings: mock(() => Promise.reject(new ServerError(502, 'bad gateway'))),
      };
      expect(await failureOf(api, GITLAB, repository(), KEY)).toMatchObject({
        message: expect.stringContaining('bad gateway'),
      });
    });
  });
});

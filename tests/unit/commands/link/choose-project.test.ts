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

// Unit tests for `sonar link` without a project key: the discovery proposal and the search picker.

import { dirname } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import * as gitWorktree from '@/core/host/git/worktree.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import {
  type CompleteProjectMapping,
  DiscoveredProjects,
} from '@/core/project-discovery/project-discovery-result.ts';
import * as projectInfo from '@/core/project-discovery/project-info.ts';
import { sharedProjectConfigRepository } from '@/core/project-discovery/shared-project-config.ts';
import { errAsync, okAsync } from '@/core/result.ts';
import { TransportError } from '@/core/server/errors.ts';
import { ProjectsClient } from '@/core/server/projects.ts';
import type { ProjectsSearchResponse } from '@/core/server/types.ts';

import { link } from '../../../../src/commands/link/index.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';

const SERVER_URL = 'https://sonarqube.example.com';
const root = canonicalizePath(process.cwd());

const auth = new ResolvedAuth({
  token: 'test-token',
  serverUrl: SERVER_URL,
  connectionType: 'on-premise',
  source: 'state',
});

function mapping(projectKey: string, projectRoot = root): CompleteProjectMapping {
  return { projectRoot, projectKey, serverUrl: SERVER_URL };
}

function searchResult(keys: string[], total = keys.length): ProjectsSearchResponse {
  return {
    paging: { pageIndex: 1, pageSize: keys.length, total },
    components: keys.map((key) => ({ key, name: `Name of ${key}` })),
  };
}

describe('link without a project key', () => {
  let fake: FakeConsole;
  let ctx: CommandAuthenticatedInvocationContext;
  let discoverSpy: Mock<typeof projectInfo.discoverProjects>;
  let findSpy: Mock<ProjectsClient['findProject']>;
  let searchSpy: Mock<ProjectsClient['searchProjects']>;
  let setSpy: Mock<typeof sharedProjectConfigRepository.set>;
  let addProjectSpy: Mock<typeof sharedProjectConfigRepository.addProject>;
  let gitRootSpy: Mock<typeof gitWorktree.resolveGitRepoRoot>;

  function discovered(projects: CompleteProjectMapping[], fromSharedConfig = false): void {
    discoverSpy.mockResolvedValue(new DiscoveredProjects(root, projects, fromSharedConfig));
  }

  beforeEach(() => {
    fake = new FakeConsole();
    ctx = new CommandAuthenticatedInvocationContext(auth, fake);
    gitRootSpy = spyOn(gitWorktree, 'resolveGitRepoRoot').mockResolvedValue(process.cwd());
    setSpy = spyOn(sharedProjectConfigRepository, 'set').mockResolvedValue(false);
    addProjectSpy = spyOn(sharedProjectConfigRepository, 'addProject').mockResolvedValue(undefined);
    discoverSpy = spyOn(projectInfo, 'discoverProjects');
    discovered([]);
    findSpy = spyOn(ProjectsClient.prototype, 'findProject').mockReturnValue(okAsync(null));
    searchSpy = spyOn(ProjectsClient.prototype, 'searchProjects').mockReturnValue(
      okAsync(searchResult(['found'])),
    );
  });

  afterEach(() => {
    for (const spy of [gitRootSpy, setSpy, addProjectSpy, discoverSpy, findSpy, searchSpy] as Mock<
      (...args: never[]) => unknown
    >[]) {
      spy.mockRestore();
    }
  });

  function writtenKey(): string | undefined {
    return setSpy.mock.calls.at(0)?.[1].projectKey;
  }

  describe('proposal', () => {
    it('proposes a discovered project that exists on the server and links it when accepted', async () => {
      discovered([mapping('discovered')]);
      findSpy.mockReturnValue(okAsync({ key: 'discovered', name: 'Discovered Project' }));

      await link(undefined, { path: '.' }, ctx);

      expect(
        fake.findCall('confirmPrompt', `Link ${root} to Discovered Project (discovered)?`),
      ).toBeDefined();
      expect(writtenKey()).toBe('discovered');
      expect(searchSpy).not.toHaveBeenCalled();
    });

    it('runs discovery with the auth and silently, so output does not mix with prompts', async () => {
      await link(undefined, { path: '.' }, ctx).catch(() => undefined);

      expect(discoverSpy).toHaveBeenCalledWith(
        root,
        expect.objectContaining({ auth, silent: true }),
      );
    });

    it('does not propose a discovered key the server does not know', async () => {
      discovered([mapping('stale')]);

      await link(undefined, { path: '.' }, ctx);

      expect(fake.findCall('confirmPrompt', 'Link')).toBeUndefined();
      expect(writtenKey()).toBe('found');
    });

    it('treats a failed verification as not proposable', async () => {
      discovered([mapping('maybe')]);
      findSpy.mockReturnValue(errAsync(new TransportError('boom')));

      await link(undefined, { path: '.' }, ctx);

      expect(fake.findCall('confirmPrompt', 'Link')).toBeUndefined();
      expect(searchSpy).toHaveBeenCalled();
    });

    it('opens the search list when the proposal is declined', async () => {
      discovered([mapping('discovered')]);
      findSpy.mockReturnValue(okAsync({ key: 'discovered', name: 'Discovered' }));
      fake.queueResponse(false);

      await link(undefined, { path: '.' }, ctx);

      expect(writtenKey()).toBe('found');
    });

    it('skips a candidate recorded against another server', async () => {
      discovered([{ ...mapping('elsewhere'), serverUrl: 'https://other.example.com' }]);

      await link(undefined, { path: '.' }, ctx);

      expect(findSpy).not.toHaveBeenCalled();
    });

    it('reports a directory already covered by .sonar-config.json and keeps the link by default', async () => {
      discovered([mapping('already')], true);

      await link(undefined, { path: '.' }, ctx);

      expect(fake.findCall('info', 'is already linked to project already')).toBeDefined();
      expect(fake.findCall('confirmPrompt', 'Link it to another project instead?')).toBeDefined();
      expect(findSpy).not.toHaveBeenCalled();
      expect(searchSpy).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('names the nearest covering project, not an enclosing one listed first', async () => {
      discovered([mapping('outer', dirname(root)), mapping('inner')], true);

      await link(undefined, { path: '.' }, ctx);

      expect(fake.findCall('info', 'is already linked to project inner')).toBeDefined();
      expect(fake.findCall('info', 'is already linked to project outer')).toBeUndefined();
    });

    it('opens the search list when the user wants to link an already linked directory elsewhere', async () => {
      discovered([mapping('already')], true);
      fake.queueResponse(true);

      await link(undefined, { path: '.' }, ctx);

      expect(findSpy).not.toHaveBeenCalled();
      expect(writtenKey()).toBe('found');
    });

    it('fails when the relink prompt is cancelled', async () => {
      discovered([mapping('already')], true);
      fake.queueResponse(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(link(undefined, { path: '.' }, ctx)).rejects.toThrow(
        'Project selection cancelled',
      );
    });

    it('does not propose mappings of other directories in monorepo mode', async () => {
      discovered([mapping('api', `${root}/services/api`)], true);

      await link(undefined, { path: '.', monorepo: true }, ctx);

      expect(findSpy).not.toHaveBeenCalled();
      expect(fake.findCall('info', 'already linked')).toBeUndefined();
      expect(addProjectSpy).toHaveBeenCalledWith(
        process.cwd(),
        expect.objectContaining({ projectKey: 'found' }),
      );
    });

    it('offers a repo-wide suggestion for the --path directory in monorepo mode', async () => {
      discovered([mapping('repo-wide')]);
      findSpy.mockReturnValue(okAsync({ key: 'repo-wide', name: 'Repo Wide' }));

      await link(undefined, { path: '.', monorepo: true }, ctx);

      expect(
        fake.findCall('confirmPrompt', `Link ${root} to Repo Wide (repo-wide)?`),
      ).toBeDefined();
      expect(addProjectSpy).toHaveBeenCalledWith(
        process.cwd(),
        expect.objectContaining({ projectKey: 'repo-wide' }),
      );
    });
  });

  describe('search list', () => {
    it('searches on the server with the typed query and links the picked project', async () => {
      searchSpy.mockReturnValue(okAsync(searchResult(['a', 'b'])));
      fake.queueResponse({ query: 'my term', pick: 'b' });

      await link(undefined, { path: '.' }, ctx);

      expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ q: 'my term' }));
      expect(fake.findCall('searchPrompt', 'Choose a project')).toBeDefined();
      expect(writtenKey()).toBe('b');
    });

    it('lists everything for an empty query', async () => {
      await link(undefined, { path: '.' }, ctx);

      expect(searchSpy.mock.calls.at(0)?.[0].q).toBeUndefined();
      expect(writtenKey()).toBe('found');
    });

    it('asks the server for one short page and reports the total', async () => {
      searchSpy.mockReturnValue(okAsync(searchResult(['a', 'b'], 2175)));
      const searchPrompt = spyOn(fake, 'searchPrompt');

      await link(undefined, { path: '.' }, ctx);

      expect(searchSpy.mock.calls.at(0)?.[0].ps).toBe(10);
      expect(searchPrompt).toHaveBeenCalledWith(
        'Choose a project',
        expect.objectContaining({ noun: 'projects', minQueryLength: 2 }),
      );
      const results = await searchPrompt.mock.calls.at(0)?.[1].search('');
      expect(results?.total).toBe(2175);
    });

    it('shows the project name with its key as the detail column', async () => {
      const searchPrompt = spyOn(fake, 'searchPrompt');
      searchSpy.mockReturnValue(okAsync(searchResult(['a'])));

      await link(undefined, { path: '.' }, ctx);

      const results = await searchPrompt.mock.calls.at(0)?.[1].search('a');
      expect(results).toEqual({
        options: [{ value: 'a', label: 'Name of a', detail: 'a' }],
        total: 1,
      });
    });

    it('fails with a hint when the search itself fails', async () => {
      searchSpy.mockReturnValue(errAsync(new TransportError('down')));

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(link(undefined, { path: '.' }, ctx)).rejects.toThrow(
        'Could not search projects',
      );
      expect(setSpy).not.toHaveBeenCalled();
    });
  });

  describe('non-interactive and cancelled runs', () => {
    it('fails without a terminal, pointing at the explicit form, before touching the server', async () => {
      fake.setCanPrompt(false);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(link(undefined, { path: '.' }, ctx)).rejects.toThrow('cannot prompt');
      expect(discoverSpy).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('fails when the search prompt is cancelled', async () => {
      fake.queueResponse(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(link(undefined, { path: '.' }, ctx)).rejects.toThrow(
        'Project selection cancelled',
      );
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('fails when the proposal prompt is cancelled', async () => {
      discovered([mapping('discovered')]);
      findSpy.mockReturnValue(okAsync({ key: 'discovered', name: 'Discovered' }));
      fake.queueResponse(null);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(link(undefined, { path: '.' }, ctx)).rejects.toThrow(
        'Project selection cancelled',
      );
    });

    it('never discovers or prompts when the key is given', async () => {
      await link('explicit', { path: '.' }, ctx);

      expect(discoverSpy).not.toHaveBeenCalled();
      expect(fake.findCall('searchPrompt', 'Choose a project')).toBeUndefined();
      expect(writtenKey()).toBe('explicit');
    });
  });
});

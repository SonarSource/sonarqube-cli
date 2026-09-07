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

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, Mock, spyOn } from 'bun:test';

import { SONARCLOUD_URL, SONARCLOUD_US_URL } from '@/core/config-constants.ts';
import * as gitDiscover from '@/core/host/git/discover.ts';
import * as lookupPathResolver from '@/core/host/git/lookup-path-resolver.ts';
import * as gitWorktree from '@/core/host/git/worktree.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import {
  discoverOrganization,
  discoverProject,
  discoverServer,
  KNOWN_SERVER_PROJECT_MAPPING_SOURCE,
} from '@/core/project-info.ts';
import * as discoverByRemote from '@/core/server/discover-project-by-remote.ts';
import { GIT_REMOTE_BINDING_SOURCE } from '@/core/server/discover-project-by-remote.ts';
import type { KnownServerProjectMapping } from '@/core/state/state.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';

import { FakeConsole } from '../../_common/fake-console.ts';
import { createFakeFsTestHandle } from './fake-fs-test-handle.ts';

const fakeFs = createFakeFsTestHandle();

function withCwd<T>(
  cwdSpy: Mock<typeof process.cwd>,
  dir: string,
  fn: () => Promise<T>,
): Promise<T> {
  cwdSpy.mockReturnValue(dir);
  return fn();
}

/** Default `resolveLookupPaths` mock: bounded to the invocation dir itself, like the real non-git outcome — never falls through to a real `git` spawn. */
function defaultLookupPaths(startDir: string): Promise<lookupPathResolver.LookupPath[]> {
  const checkPath = canonicalizePath(startDir);
  return Promise.resolve([{ checkPath, projectRoot: checkPath }]);
}

/** Points an already-spied `resolveLookupPaths` at the nearest-first climb `dirs` represents. */
function mockClimb(
  lookupPathsSpy: Mock<typeof lookupPathResolver.resolveLookupPaths>,
  ...dirs: string[]
): void {
  lookupPathsSpy.mockResolvedValue(
    dirs.map((dir) => {
      const checkPath = canonicalizePath(dir);
      return { checkPath, projectRoot: checkPath };
    }),
  );
}

function makeKnownMapping(
  overrides: Partial<KnownServerProjectMapping> = {},
): KnownServerProjectMapping {
  return {
    targetRoot: '',
    projectKey: 'known-project',
    serverUrl: 'https://known.example.com',
    ...overrides,
  };
}

function mockKnownMappings(
  loadStateSpy: Mock<typeof stateRepository.loadState>,
  mappings: KnownServerProjectMapping[],
): void {
  loadStateSpy.mockReturnValue({
    ...getDefaultState('1.0.0'),
    knownServerProjectMappings: mappings,
  });
}

describe('discoverProject', () => {
  let testDir: string;
  let loadStateSpy: Mock<typeof stateRepository.loadState>;
  let lookupPathsSpy: Mock<typeof lookupPathResolver.resolveLookupPaths>;
  let remoteSpy: Mock<typeof discoverByRemote.discoverProjectKeyByGitRemote>;
  let getGitRemoteSpy: Mock<typeof gitDiscover.getGitRemote>;
  let mainWorktreeSpy: Mock<typeof gitWorktree.resolveMainWorktreeRoot>;

  beforeEach(() => {
    fakeFs.setup();
    testDir = join(tmpdir(), `sonarqube-cli-test-discover-project-${Date.now()}`);
    fakeFs.mkdir(testDir);
    // Isolate from the real ~/.sonar state.json — most tests here don't care about
    // known-project-mapping lookups, only the dedicated tests below do.
    loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(getDefaultState('1.0.0'));
    lookupPathsSpy = spyOn(lookupPathResolver, 'resolveLookupPaths').mockImplementation(
      defaultLookupPaths,
    );
    remoteSpy = spyOn(discoverByRemote, 'discoverProjectKeyByGitRemote').mockResolvedValue(null);
    getGitRemoteSpy = spyOn(gitDiscover, 'getGitRemote').mockResolvedValue('');
    mainWorktreeSpy = spyOn(gitWorktree, 'resolveMainWorktreeRoot').mockResolvedValue(null);
  });

  afterEach(() => {
    fakeFs.teardown();
    loadStateSpy.mockRestore();
    getGitRemoteSpy.mockRestore();
    mainWorktreeSpy.mockRestore();
    lookupPathsSpy.mockRestore();
    remoteSpy.mockRestore();
  });

  it('resolves repoRoot from filesystem, undefined outside a git repository', async () => {
    expect(
      (await discoverProject(testDir, { console: new FakeConsole() })).repoRoot,
    ).toBeUndefined();

    fakeFs.mkdir(join(testDir, '.git'));
    const withGit = await discoverProject(testDir, { console: new FakeConsole() });
    expect(withGit.repoRoot).toBe(canonicalizePath(testDir));
  });

  it('defaults projectRoot to the invocation directory when nothing else resolves', async () => {
    expect((await discoverProject(testDir, { console: new FakeConsole() })).projectRoot).toBe(
      canonicalizePath(testDir),
    );
  });

  it('defaults projectRoot to the invocation directory, not repoRoot, even inside a git repo', async () => {
    fakeFs.mkdir(join(testDir, '.git'));
    const subDir = join(testDir, 'packages', 'app');
    fakeFs.mkdir(subDir);

    const result = await discoverProject(subDir, { console: new FakeConsole() });

    expect(result.repoRoot).toBe(canonicalizePath(testDir));
    expect(result.projectRoot).toBe(canonicalizePath(subDir));
  });

  it('no config: no server fields and no text UI', async () => {
    const fake = new FakeConsole();
    const result = await discoverProject(testDir, { console: fake });
    expect(result.serverUrl).toBeUndefined();
    expect(result.projectKey).toBeUndefined();
    expect(result.organization).toBeUndefined();
    expect(fake.calls.filter((c) => c.method === 'print')).toHaveLength(0);
  });

  it('ignores comments and blank lines in sonar-project.properties', async () => {
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      '\n# comment\nsonar.host.url=https://sonarcloud.io\n\n# another\nsonar.projectKey=my_project\n',
    );

    const result = await discoverProject(testDir, { console: new FakeConsole() });

    expect(result.serverUrl).toBe('https://sonarcloud.io');
    expect(result.projectKey).toBe('my_project');
  });

  it('ignores a property line without an equals sign', async () => {
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://sonarcloud.io\nsonar.projectKey=my_key\nINVALID_LINE_NO_EQUALS\n',
    );

    const result = await discoverProject(testDir, { console: new FakeConsole() });

    expect(result.projectKey).toBe('my_key');
  });

  it('does not treat sonar-project.properties as a match when it has no hostURL or projectKey', async () => {
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      'sonar.projectName=My Project\nsonar.organization=my-org\n',
    );

    const result = await discoverProject(testDir, { console: new FakeConsole() });

    expect(result.serverUrl).toBeUndefined();
    expect(result.projectKey).toBeUndefined();
    expect(result.configSources).toEqual([]);
  });

  it('does not treat a .sonarlint dir with no usable binding file as a match', async () => {
    fakeFs.writeFile(join(testDir, '.sonarlint', 'notes.txt'), 'not json');

    const result = await discoverProject(testDir, { console: new FakeConsole() });

    expect(result.serverUrl).toBeUndefined();
    expect(result.projectKey).toBeUndefined();
    expect(result.configSources).toEqual([]);
  });

  it('maps sonar-project.properties to DiscoveredProject and updates configSources', async () => {
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://sonarcloud.io\nsonar.projectKey=my_project\nsonar.organization=my-org\n',
    );
    const result = await discoverProject(testDir, { console: new FakeConsole() });
    expect(result.serverUrl).toBe('https://sonarcloud.io');
    expect(result.projectKey).toBe('my_project');
    expect(result.organization).toBe('my-org');
    expect(result.configSources).toEqual(['sonar-project.properties']);
  });

  it('maps SonarQube Server connected mode to DiscoveredProject and updates configSources', async () => {
    fakeFs.writeFile(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({
        sonarQubeUri: 'https://sonarqube.example.com',
        projectKey: 'lint_project',
        organization: 'must-be-ignored',
      }),
    );
    const result = await discoverProject(testDir, { console: new FakeConsole() });
    expect(result.serverUrl).toBe('https://sonarqube.example.com');
    expect(result.projectKey).toBe('lint_project');
    expect(result.organization).toBeUndefined();
    expect(result.configSources).toEqual([join('.sonarlint', 'connectedMode.json')]);
  });

  it('maps SonarQube Cloud connected mode to DiscoveredProject (region EU / US)', async () => {
    for (const { region, url } of [
      { region: 'EU', url: SONARCLOUD_URL },
      { region: 'US', url: SONARCLOUD_US_URL },
    ]) {
      fakeFs.writeFile(
        join(testDir, '.sonarlint', 'connectedMode.json'),
        JSON.stringify({
          sonarCloudOrganization: 'my-org',
          projectKey: 'org_project',
          region,
        }),
      );
      const result = await discoverProject(testDir, { console: new FakeConsole() });
      expect(result.serverUrl).toBe(url);
      expect(result.projectKey).toBe('org_project');
      expect(result.organization).toBe('my-org');
      fakeFs.rm(join(testDir, '.sonarlint'));
    }
  });

  it('sonar-project.properties wins over SonarLint for serverUrl and projectKey', async () => {
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://props-server.io\nsonar.projectKey=props_project\n',
    );
    fakeFs.writeFile(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarQubeUri: 'https://sonarlint-server.com', projectKey: 'lint_project' }),
    );
    const result = await discoverProject(testDir, { console: new FakeConsole() });
    expect(result.serverUrl).toBe('https://props-server.io');
    expect(result.projectKey).toBe('props_project');
  });

  it('SonarLint fills projectKey or organization when properties omit them', async () => {
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://props-server.io\n',
    );
    fakeFs.writeFile(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarQubeUri: 'https://sonarlint-server.com', projectKey: 'from_lint' }),
    );
    expect((await discoverProject(testDir, { console: new FakeConsole() })).projectKey).toBe(
      'from_lint',
    );

    fakeFs.rm(join(testDir, '.sonarlint'));
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://props-server.io\nsonar.projectKey=props_project\n',
    );
    fakeFs.writeFile(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarCloudOrganization: 'lint-org', projectKey: 'lint_project' }),
    );
    expect((await discoverProject(testDir, { console: new FakeConsole() })).organization).toBe(
      'lint-org',
    );
  });

  it('updates configSources when both sonar-project.properties and .sonarlint exist', async () => {
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://props-server.io\nsonar.projectKey=props_project\n',
    );
    fakeFs.writeFile(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarQubeUri: 'https://sonarlint-server.com', projectKey: 'lint_project' }),
    );
    const result = await discoverProject(testDir, { console: new FakeConsole() });
    expect(result.configSources).toEqual([
      'sonar-project.properties',
      join('.sonarlint', 'connectedMode.json'),
    ]);
  });

  it('resolves projectKey from git remote when authenticated and no local project key', async () => {
    fakeFs.mkdir(join(testDir, '.git'));
    getGitRemoteSpy.mockResolvedValue('https://github.com/example/remote-bound.git');
    remoteSpy.mockResolvedValue({
      projectKey: 'from-remote',
      serverUrl: 'https://sonarcloud.io',
      organization: 'my-org',
    });

    const result = await discoverProject(testDir, {
      console: new FakeConsole(),
      auth: {
        token: 'token',
        serverUrl: 'https://sonarcloud.io',
        orgKey: 'my-org',
        connectionType: 'cloud',
      },
    });
    expect(result.projectKey).toBe('from-remote');
    expect(result.organization).toBe('my-org');
    expect(result.configSources).toEqual([GIT_REMOTE_BINDING_SOURCE]);
    expect(remoteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ orgKey: 'my-org' }),
      'https://github.com/example/remote-bound.git',
    );
  });

  it('does not call git remote lookup when projectKey is already in local config', async () => {
    fakeFs.mkdir(join(testDir, '.git'));
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://sonarcloud.io\nsonar.projectKey=local_key\n',
    );
    remoteSpy.mockResolvedValue({
      projectKey: 'from-remote',
      serverUrl: 'https://sonarcloud.io',
    });

    const result = await discoverProject(testDir, {
      console: new FakeConsole(),
      auth: { token: 't', serverUrl: 'https://sonarcloud.io', connectionType: 'cloud' },
    });
    expect(result.projectKey).toBe('local_key');
    expect(remoteSpy).not.toHaveBeenCalled();
  });

  it('skips git remote lookup when tryGitRemoteBinding is false', async () => {
    fakeFs.mkdir(join(testDir, '.git'));
    remoteSpy.mockResolvedValue({
      projectKey: 'from-remote',
      serverUrl: 'https://sonarcloud.io',
    });

    await discoverProject(testDir, {
      console: new FakeConsole(),
      auth: { token: 't', serverUrl: 'https://sonarcloud.io', connectionType: 'cloud' },
      tryGitRemoteBinding: false,
      silent: true,
    });
    expect(remoteSpy).not.toHaveBeenCalled();
  });

  it('returns a partial result instead of throwing when lookup-path resolution fails', async () => {
    lookupPathsSpy.mockRejectedValue(new Error('simulated failure'));

    const result = await discoverProject(testDir, { console: new FakeConsole() });

    expect(result.projectKey).toBeUndefined();
    expect(result.projectRoot).toBe(canonicalizePath(testDir));
    expect(result.configSources).toEqual([]);
  });

  describe('known server project mapping', () => {
    it('uses a known project mapping when no local config provides one', async () => {
      mockKnownMappings(loadStateSpy, [
        makeKnownMapping({ targetRoot: canonicalizePath(testDir), orgKey: 'known-org' }),
      ]);

      const result = await discoverProject(testDir, { console: new FakeConsole() });

      expect(result.projectKey).toBe('known-project');
      expect(result.serverUrl).toBe('https://known.example.com');
      expect(result.organization).toBe('known-org');
      expect(result.configSources).toEqual([KNOWN_SERVER_PROJECT_MAPPING_SOURCE]);
      expect(result.projectRoot).toBe(canonicalizePath(testDir));
      expect(result.integrationDir).toBe(canonicalizePath(testDir));
    });

    it("sets integrationDir to the matched mapping's own targetRoot, which can differ from projectRoot", async () => {
      // Matched via the repoRoot signal: projectRoot anchors here, integrationDir stays elsewhere.
      const otherWorktreeInstallDir = join(testDir, '..', 'other-worktree-install-dir');
      mockKnownMappings(loadStateSpy, [
        makeKnownMapping({
          targetRoot: canonicalizePath(otherWorktreeInstallDir),
          repoRoot: canonicalizePath(testDir),
        }),
      ]);

      const result = await discoverProject(testDir, { console: new FakeConsole() });

      expect(result.projectKey).toBe('known-project');
      expect(result.projectRoot).toBe(canonicalizePath(testDir));
      expect(result.integrationDir).toBe(canonicalizePath(otherWorktreeInstallDir));
    });

    it('matches from a subdirectory of the mapped folder', async () => {
      const subDir = join(testDir, 'nested', 'sub');
      mockKnownMappings(loadStateSpy, [
        makeKnownMapping({ targetRoot: canonicalizePath(testDir) }),
      ]);
      mockClimb(lookupPathsSpy, subDir, join(testDir, 'nested'), testDir);

      const result = await discoverProject(subDir, { console: new FakeConsole() });

      expect(result.projectKey).toBe('known-project');
    });

    it("passes every known mapping's targetRoot/repoRoot as the resolveLookupPaths bound, unfiltered", async () => {
      // Deduplication/nesting is resolveLookupPaths()'s job, not discoverProject()'s.
      const repoRoot = join(testDir, '..');
      mockKnownMappings(loadStateSpy, [
        makeKnownMapping({
          targetRoot: canonicalizePath(testDir),
          repoRoot: canonicalizePath(repoRoot),
        }),
      ]);

      await discoverProject(testDir, { console: new FakeConsole() });

      expect(lookupPathsSpy).toHaveBeenCalledWith(testDir, [
        canonicalizePath(testDir),
        canonicalizePath(repoRoot),
      ]);
    });

    it('matches a known mapping recorded at a subdirectory below the git repo root (monorepo package)', async () => {
      // Regression test: discoverProject() must pass the raw invocation directory
      // (not the already-collapsed git repo root) into the known-mapping lookup, so a
      // mapping recorded at a nested package folder still matches from inside it.
      const packageDir = join(testDir, 'packages', 'api');
      const invokeDir = join(packageDir, 'src');
      mockKnownMappings(loadStateSpy, [
        makeKnownMapping({
          targetRoot: canonicalizePath(packageDir),
          projectKey: 'package-project',
        }),
      ]);
      mockClimb(lookupPathsSpy, invokeDir, packageDir, testDir);

      const result = await discoverProject(invokeDir, { console: new FakeConsole() });

      expect(result.projectKey).toBe('package-project');
      expect(result.projectRoot).toBe(canonicalizePath(packageDir));
    });

    it('does not match an unrelated folder', async () => {
      mockKnownMappings(loadStateSpy, [
        makeKnownMapping({
          targetRoot: join(tmpdir(), 'some-other-project'),
          projectKey: 'other-project',
        }),
      ]);

      const result = await discoverProject(testDir, { console: new FakeConsole() });

      expect(result.projectKey).toBeUndefined();
    });

    it('a known project mapping wins over sonar-project.properties and skips reading it', async () => {
      fakeFs.writeFile(
        join(testDir, 'sonar-project.properties'),
        'sonar.host.url=https://props-server.io\nsonar.projectKey=props_project\n',
      );
      mockKnownMappings(loadStateSpy, [
        makeKnownMapping({ targetRoot: canonicalizePath(testDir) }),
      ]);

      const result = await discoverProject(testDir, { console: new FakeConsole() });

      expect(result.projectKey).toBe('known-project');
      expect(result.serverUrl).toBe('https://known.example.com');
      expect(result.configSources).toEqual([KNOWN_SERVER_PROJECT_MAPPING_SOURCE]);
    });

    it('is checked before, and short-circuits, the git-remote binding network lookup', async () => {
      fakeFs.mkdir(join(testDir, '.git'));
      mockKnownMappings(loadStateSpy, [
        makeKnownMapping({ targetRoot: canonicalizePath(testDir) }),
      ]);
      remoteSpy.mockResolvedValue({
        projectKey: 'from-remote',
        serverUrl: 'https://sonarcloud.io',
      });

      const result = await discoverProject(testDir, {
        console: new FakeConsole(),
        auth: { token: 't', serverUrl: 'https://sonarcloud.io', connectionType: 'cloud' },
      });

      expect(result.projectKey).toBe('known-project');
      expect(remoteSpy).not.toHaveBeenCalled();
    });

    it('falls through to git-remote binding when no known mapping matches', async () => {
      fakeFs.mkdir(join(testDir, '.git'));
      getGitRemoteSpy.mockResolvedValue('https://github.com/example/remote-bound.git');
      remoteSpy.mockResolvedValue({
        projectKey: 'from-remote',
        serverUrl: 'https://sonarcloud.io',
      });

      const result = await discoverProject(testDir, {
        console: new FakeConsole(),
        auth: { token: 't', serverUrl: 'https://sonarcloud.io', connectionType: 'cloud' },
      });

      expect(result.projectKey).toBe('from-remote');
    });

    it('gracefully skips when loadState throws', async () => {
      loadStateSpy.mockImplementation(() => {
        throw new Error('state read failed');
      });

      const result = await discoverProject(testDir, { console: new FakeConsole() });

      expect(result.projectKey).toBeUndefined();
    });

    it('falls back to a live-derived mapping from installed features when the persisted table has no match', async () => {
      const state = getDefaultState('1.0.0');
      state.integrations.installed = [
        {
          id: 'integration-1',
          integrationId: 'claude-code',
          installedByCliVersion: '1.0.0',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedByCliVersion: '1.0.0',
          updatedAt: '2026-01-01T00:00:00.000Z',
          features: [
            {
              featureId: 'vortex',
              scope: 'project',
              targetRoot: canonicalizePath(testDir),
              installedByCliVersion: '1.0.0',
              installedAt: '2026-01-01T00:00:00.000Z',
              updatedByCliVersion: '1.0.0',
              updatedAt: '2026-01-01T00:00:00.000Z',
              dependencies: [],
              resources: [],
              operations: [],
              attrs: { projectKey: 'live-project', serverUrl: 'https://live.example.com' },
            },
          ],
        },
      ];
      loadStateSpy.mockReturnValue(state);

      const result = await discoverProject(testDir, { console: new FakeConsole() });

      expect(result.projectKey).toBe('live-project');
      expect(result.serverUrl).toBe('https://live.example.com');
      expect(result.configSources).toEqual([KNOWN_SERVER_PROJECT_MAPPING_SOURCE]);
    });

    it('prefers the live fallback over a stale persisted-table entry for the same targetRoot', async () => {
      // Re-integration must not be shadowed by a stale persisted entry awaiting migration.
      const state = getDefaultState('1.0.0');
      state.knownServerProjectMappings = [
        makeKnownMapping({
          targetRoot: canonicalizePath(testDir),
          projectKey: 'persisted-project',
        }),
      ];
      state.integrations.installed = [
        {
          id: 'integration-1',
          integrationId: 'claude-code',
          installedByCliVersion: '1.0.0',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedByCliVersion: '1.0.0',
          updatedAt: '2026-01-01T00:00:00.000Z',
          features: [
            {
              featureId: 'vortex',
              scope: 'project',
              targetRoot: canonicalizePath(testDir),
              installedByCliVersion: '1.0.0',
              installedAt: '2026-01-01T00:00:00.000Z',
              updatedByCliVersion: '1.0.0',
              updatedAt: '2026-01-01T00:00:00.000Z',
              dependencies: [],
              resources: [],
              operations: [],
              attrs: { projectKey: 'live-project', serverUrl: 'https://live.example.com' },
            },
          ],
        },
      ];
      loadStateSpy.mockReturnValue(state);

      const result = await discoverProject(testDir, { console: new FakeConsole() });

      expect(result.projectKey).toBe('live-project');
    });

    it('prefers a nearer live-derived mapping over a farther persisted-table one', async () => {
      const subDir = join(testDir, 'packages', 'api');
      fakeFs.mkdir(subDir);

      const state = getDefaultState('1.0.0');
      // Persisted table only knows about the repo root, from an earlier migration.
      state.knownServerProjectMappings = [
        makeKnownMapping({
          targetRoot: canonicalizePath(testDir),
          projectKey: 'root-persisted-project',
        }),
      ];
      // A subpackage was integrated afterwards and hasn't been migrated into the
      // persisted table yet — it's only visible via the live fallback.
      state.integrations.installed = [
        {
          id: 'integration-1',
          integrationId: 'claude-code',
          installedByCliVersion: '1.0.0',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedByCliVersion: '1.0.0',
          updatedAt: '2026-01-01T00:00:00.000Z',
          features: [
            {
              featureId: 'vortex',
              scope: 'project',
              targetRoot: canonicalizePath(subDir),
              installedByCliVersion: '1.0.0',
              installedAt: '2026-01-01T00:00:00.000Z',
              updatedByCliVersion: '1.0.0',
              updatedAt: '2026-01-01T00:00:00.000Z',
              dependencies: [],
              resources: [],
              operations: [],
              attrs: { projectKey: 'live-sub-project', serverUrl: 'https://live-sub.example.com' },
            },
          ],
        },
      ];
      loadStateSpy.mockReturnValue(state);

      const result = await discoverProject(subDir, { console: new FakeConsole() });

      expect(result.projectKey).toBe('live-sub-project');
    });

    describe('connection resolution for mappings that recorded no serverUrl', () => {
      function withActiveConnection(state: ReturnType<typeof getDefaultState>): void {
        state.auth.connections = [
          {
            id: 'conn-1',
            type: 'cloud',
            serverUrl: 'https://active-connection.example.com',
            orgKey: 'active-org',
            authenticatedAt: '2026-01-01T00:00:00.000Z',
          },
        ];
        state.auth.activeConnectionId = 'conn-1';
      }

      it('substitutes the currently active connection, resolved fresh, not baked in at derive time', async () => {
        const state = getDefaultState('1.0.0');
        state.knownServerProjectMappings = [
          makeKnownMapping({
            targetRoot: canonicalizePath(testDir),
            serverUrl: undefined,
            orgKey: undefined,
          }),
        ];
        withActiveConnection(state);
        loadStateSpy.mockReturnValue(state);

        const result = await discoverProject(testDir, { console: new FakeConsole() });

        expect(result.projectKey).toBe('known-project');
        expect(result.serverUrl).toBe('https://active-connection.example.com');
        expect(result.organization).toBe('active-org');
      });

      it('falls through to the next discovery source when no connection can be resolved at all', async () => {
        const state = getDefaultState('1.0.0');
        state.knownServerProjectMappings = [
          makeKnownMapping({
            targetRoot: canonicalizePath(testDir),
            serverUrl: undefined,
            orgKey: undefined,
          }),
        ];
        // No active connection set: the mapping matches by path, but there is nothing to
        // resolve a serverUrl from, so it must not "succeed" with an undefined serverUrl.
        loadStateSpy.mockReturnValue(state);
        fakeFs.writeFile(
          join(testDir, 'sonar-project.properties'),
          'sonar.host.url=https://props-server.io\nsonar.projectKey=props_project\n',
        );

        const result = await discoverProject(testDir, { console: new FakeConsole() });

        expect(result.projectKey).toBe('props_project');
        expect(result.configSources).toEqual(['sonar-project.properties']);
      });

      it("prefers the caller's own resolved auth over the active connection in state", async () => {
        const state = getDefaultState('1.0.0');
        state.knownServerProjectMappings = [
          makeKnownMapping({
            targetRoot: canonicalizePath(testDir),
            serverUrl: undefined,
            orgKey: undefined,
          }),
        ];
        // Active connection in state disagrees with the auth the caller actually resolved
        // and passed in — e.g. env-var auth that hasn't been persisted yet.
        withActiveConnection(state);
        loadStateSpy.mockReturnValue(state);

        const result = await discoverProject(testDir, {
          console: new FakeConsole(),
          auth: {
            token: 't',
            serverUrl: 'https://env-auth.example.com',
            orgKey: 'env-org',
            connectionType: 'cloud',
          },
        });

        expect(result.serverUrl).toBe('https://env-auth.example.com');
        expect(result.organization).toBe('env-org');
      });

      it("never mixes a recorded serverUrl with the active connection's orgKey", async () => {
        const state = getDefaultState('1.0.0');
        state.knownServerProjectMappings = [
          makeKnownMapping({
            targetRoot: canonicalizePath(testDir),
            serverUrl: 'https://recorded.example.com',
            orgKey: undefined,
          }),
        ];
        withActiveConnection(state);
        loadStateSpy.mockReturnValue(state);

        const result = await discoverProject(testDir, { console: new FakeConsole() });

        expect(result.serverUrl).toBe('https://recorded.example.com');
        expect(result.organization).toBeUndefined();
      });
    });
  });

  describe('local config file precedence (climbing sonar-project.properties/.sonarlint)', () => {
    it('finds sonar-project.properties at a nested subdirectory when invoked from within it', async () => {
      const subDir = join(testDir, 'packages', 'api');
      fakeFs.writeFile(
        join(subDir, 'sonar-project.properties'),
        'sonar.host.url=https://sub.example.com\nsonar.projectKey=sub_project\n',
      );

      const result = await discoverProject(subDir, { console: new FakeConsole() });

      expect(result.projectKey).toBe('sub_project');
      expect(result.serverUrl).toBe('https://sub.example.com');
      expect(result.projectRoot).toBe(canonicalizePath(subDir));
      // Resolved via a local config hint, not a recorded integration.
      expect(result.integrationDir).toBeUndefined();
    });

    it('finds .sonarlint connected mode at a nested subdirectory when invoked from within it', async () => {
      const subDir = join(testDir, 'packages', 'app');
      fakeFs.writeFile(
        join(subDir, '.sonarlint', 'connectedMode.json'),
        JSON.stringify({
          sonarQubeUri: 'https://sub-lint.example.com',
          projectKey: 'sub_lint_project',
        }),
      );

      const result = await discoverProject(subDir, { console: new FakeConsole() });

      expect(result.projectKey).toBe('sub_lint_project');
      expect(result.serverUrl).toBe('https://sub-lint.example.com');
    });

    it('prefers the nearer properties file over a farther ancestor one', async () => {
      fakeFs.writeFile(
        join(testDir, 'sonar-project.properties'),
        'sonar.host.url=https://root.example.com\nsonar.projectKey=root_project\n',
      );
      const subDir = join(testDir, 'packages', 'api');
      fakeFs.writeFile(
        join(subDir, 'sonar-project.properties'),
        'sonar.host.url=https://sub.example.com\nsonar.projectKey=sub_project\n',
      );

      const result = await discoverProject(subDir, { console: new FakeConsole() });

      expect(result.projectKey).toBe('sub_project');
      expect(result.serverUrl).toBe('https://sub.example.com');
    });

    it('climbs past a directory with only partial local config to a farther directory with a full one, inside a git repo', async () => {
      const subDir = join(testDir, 'packages', 'api');
      // Partial: host URL only, no project key — must not stop the climb.
      fakeFs.writeFile(
        join(subDir, 'sonar-project.properties'),
        'sonar.host.url=https://sub.example.com\n',
      );
      fakeFs.writeFile(
        join(testDir, 'sonar-project.properties'),
        'sonar.host.url=https://root.example.com\nsonar.projectKey=root_project\n',
      );
      mockClimb(lookupPathsSpy, subDir, join(testDir, 'packages'), testDir);

      const result = await discoverProject(subDir, { console: new FakeConsole() });

      expect(result.projectKey).toBe('root_project');
      expect(result.serverUrl).toBe('https://root.example.com');
    });

    it('does not climb to an ancestor directory for local config outside a git repository', async () => {
      // No .git anywhere in this tree: local-config discovery must stay pinned to the
      // invocation dir, not silently adopt an unrelated ancestor's sonar-project.properties.
      const subDir = join(testDir, 'packages', 'api');
      fakeFs.writeFile(
        join(subDir, 'sonar-project.properties'),
        'sonar.host.url=https://sub.example.com\n',
      );
      fakeFs.writeFile(
        join(testDir, 'sonar-project.properties'),
        'sonar.host.url=https://root.example.com\nsonar.projectKey=root_project\n',
      );

      const result = await discoverProject(subDir, { console: new FakeConsole() });

      expect(result.projectKey).toBeUndefined();
      expect(result.serverUrl).toBe('https://sub.example.com');
    });

    it('a known-mapping match at a farther directory still wins over a nearer local properties file', async () => {
      const subDir = join(testDir, 'packages', 'api');
      fakeFs.writeFile(
        join(subDir, 'sonar-project.properties'),
        'sonar.host.url=https://sub.example.com\nsonar.projectKey=sub_project\n',
      );
      mockKnownMappings(loadStateSpy, [
        makeKnownMapping({ targetRoot: canonicalizePath(testDir), projectKey: 'mapped-project' }),
      ]);
      mockClimb(lookupPathsSpy, subDir, join(testDir, 'packages'), testDir);

      const result = await discoverProject(subDir, { console: new FakeConsole() });

      expect(result.projectKey).toBe('mapped-project');
    });
  });
});

describe('discoverOrganization', () => {
  let lookupPathsSpy: Mock<typeof lookupPathResolver.resolveLookupPaths>;
  let cwdSpy: Mock<typeof process.cwd>;

  beforeEach(() => {
    fakeFs.setup();
    lookupPathsSpy = spyOn(lookupPathResolver, 'resolveLookupPaths').mockImplementation(
      defaultLookupPaths,
    );
    cwdSpy = spyOn(process, 'cwd');
  });

  afterEach(() => {
    fakeFs.teardown();
    lookupPathsSpy.mockRestore();
    cwdSpy.mockRestore();
  });

  it('reads organization from sonar-project.properties under process.cwd()', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-discover-org-props-' + Date.now());
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://x.test\nsonar.projectKey=p\nsonar.organization=from-props-org\n',
    );

    await withCwd(cwdSpy, testDir, async () => {
      expect(await discoverOrganization(new FakeConsole())).toBe('from-props-org');
    });
  });

  it('reads organization from .sonarlint when properties omit sonar.organization', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-discover-org-lint-' + Date.now());
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://x.test\nsonar.projectKey=p\n',
    );
    fakeFs.writeFile(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarCloudOrganization: 'from-lint-org', projectKey: 'k' }),
    );

    await withCwd(cwdSpy, testDir, async () => {
      expect(await discoverOrganization(new FakeConsole())).toBe('from-lint-org');
    });
  });

  it('returns null when no organization is configured', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-discover-org-empty-' + Date.now());
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://x.test\nsonar.projectKey=p\n',
    );

    await withCwd(cwdSpy, testDir, async () => {
      expect(await discoverOrganization(new FakeConsole())).toBeNull();
    });
  });

  it('climbs from a nested monorepo package to find organization at an ancestor, inside a git repo', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-discover-org-nested-' + Date.now());
    const subDir = join(testDir, 'packages', 'api');
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://x.test\nsonar.projectKey=p\nsonar.organization=ancestor-org\n',
    );
    mockClimb(lookupPathsSpy, subDir, join(testDir, 'packages'), testDir);

    await withCwd(cwdSpy, subDir, async () => {
      expect(await discoverOrganization(new FakeConsole())).toBe('ancestor-org');
    });
  });

  it('returns null when local config discovery throws', async () => {
    lookupPathsSpy.mockRejectedValue(new Error('simulated failure'));

    expect(await discoverOrganization(new FakeConsole())).toBeNull();
  });
});

describe('discoverServer', () => {
  let lookupPathsSpy: Mock<typeof lookupPathResolver.resolveLookupPaths>;
  let cwdSpy: Mock<typeof process.cwd>;
  let debugSpy: Mock<typeof logger.debug>;

  beforeEach(() => {
    fakeFs.setup();
    lookupPathsSpy = spyOn(lookupPathResolver, 'resolveLookupPaths').mockImplementation(
      defaultLookupPaths,
    );
    cwdSpy = spyOn(process, 'cwd');
    debugSpy = spyOn(logger, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fakeFs.teardown();
    lookupPathsSpy.mockRestore();
    cwdSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('reads server URL from sonar-project.properties under process.cwd()', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-discover-server-props-' + Date.now());
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://from-props.integration.test\nsonar.projectKey=p\n',
    );
    fakeFs.writeFile(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarQubeUri: 'https://from-lint.should-not-win', projectKey: 'k' }),
    );

    await withCwd(cwdSpy, testDir, async () => {
      const fake = new FakeConsole();
      expect(await discoverServer(fake)).toBe('https://from-props.integration.test');
      const prints = fake.calls.filter((c) => c.method === 'print').map((c) => String(c.args[0]));
      expect(prints.some((m) => m.includes('sonar-project.properties'))).toBe(true);
    });
  });

  it('uses SonarLint when there is no sonar-project.properties (Server or Cloud binding)', async () => {
    const cases: { json: Record<string, unknown>; expectedUrl: string }[] = [
      {
        json: { sonarQubeUri: 'https://lint-only.integration.test', projectKey: 'k' },
        expectedUrl: 'https://lint-only.integration.test',
      },
      {
        json: { sonarCloudOrganization: 'my-org', projectKey: 'cloud_lint_key' },
        expectedUrl: SONARCLOUD_URL,
      },
    ];

    for (let i = 0; i < cases.length; i++) {
      const testDir = join(tmpdir(), `sonarqube-cli-discover-server-lintonly-${i}-` + Date.now());
      fakeFs.writeFile(
        join(testDir, '.sonarlint', 'connectedMode.json'),
        JSON.stringify(cases[i].json),
      );

      await withCwd(cwdSpy, testDir, async () => {
        const fake = new FakeConsole();
        expect(await discoverServer(fake)).toBe(cases[i].expectedUrl);
        const prints = fake.calls.filter((c) => c.method === 'print').map((c) => String(c.args[0]));
        expect(prints.some((m) => m.includes('.sonarlint'))).toBe(true);
        expect(prints.some((m) => m.includes('sonar-project.properties'))).toBe(false);
      });
    }
  });

  it('returns null when cwd has no server hint', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-discover-server-empty-' + Date.now());
    fakeFs.mkdir(testDir);

    await withCwd(cwdSpy, testDir, async () => {
      const fake = new FakeConsole();
      expect(await discoverServer(fake)).toBeNull();
      expect(fake.calls.filter((c) => c.method === 'print')).toHaveLength(0);
    });
  });

  it('climbs from a nested monorepo package to find the server URL at an ancestor, inside a git repo', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-discover-server-nested-' + Date.now());
    const subDir = join(testDir, 'packages', 'api');
    fakeFs.writeFile(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://ancestor.example.com\nsonar.projectKey=p\n',
    );
    mockClimb(lookupPathsSpy, subDir, join(testDir, 'packages'), testDir);

    await withCwd(cwdSpy, subDir, async () => {
      expect(await discoverServer(new FakeConsole())).toBe('https://ancestor.example.com');
    });
  });

  it('returns null and logs when local config discovery throws', async () => {
    lookupPathsSpy.mockRejectedValue(new Error('simulated failure'));

    expect(await discoverServer(new FakeConsole())).toBeNull();
    expect(debugSpy).toHaveBeenCalled();
    expect(String(debugSpy.mock.calls[0]?.[0] ?? '')).toContain('simulated failure');
  });
});

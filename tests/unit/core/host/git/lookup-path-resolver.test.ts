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

// Unit tests for resolving the nearest-first list of directories to check for a
// recorded per-project mapping.

import { dirname } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { buildDirectoryClimb, resolveLookupPaths } from '@/core/host/git/lookup-path-resolver.ts';
import { clearGitStdoutCache } from '@/core/host/git/worktree.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import * as processLib from '@/core/process/process.ts';

const MAIN = '/repo';
const WORKTREE = '/repo-worktrees/feature-x';
const NESTED = `${MAIN}/packages/api`;
const STANDALONE_PROJECT = '/standalone-project/nested';

function canon(p: string): string {
  return canonicalizePath(p);
}

describe('buildDirectoryClimb', () => {
  it('climbs from a nested directory up to an inclusive bound', () => {
    expect(buildDirectoryClimb(`${NESTED}/src`, MAIN)).toEqual([
      canon(`${NESTED}/src`),
      canon(NESTED),
      canon(`${MAIN}/packages`),
      canon(MAIN),
    ]);
  });

  it('returns a single-element list when already at the bound', () => {
    expect(buildDirectoryClimb(MAIN, MAIN)).toEqual([canon(MAIN)]);
  });

  it('climbs to the filesystem root when no bound is given', () => {
    const climb = buildDirectoryClimb(MAIN);

    expect(climb[0]).toBe(canon(MAIN));
    const last = climb.at(-1) as string;
    expect(dirname(last)).toBe(last);
  });
});

describe('resolveLookupPaths', () => {
  let spawnProcessSpy: ReturnType<typeof spyOn>;

  function mockGitResponses(responses: Record<string, string | null>): void {
    spawnProcessSpy.mockImplementation((_cmd: string, args: string[]) => {
      const key = args.join(' ');
      if (key in responses) {
        const stdout = responses[key];
        if (stdout === null) {
          return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'git failed' });
        }
        return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
  }

  beforeEach(() => {
    spawnProcessSpy = spyOn(processLib, 'spawnProcess');
  });

  afterEach(() => {
    spawnProcessSpy.mockRestore();
    clearGitStdoutCache();
  });

  it('is bounded to the start dir itself when not inside a git repository', async () => {
    mockGitResponses({ 'rev-parse --show-toplevel': null });

    const paths = await resolveLookupPaths(STANDALONE_PROJECT);

    expect(paths).toEqual([
      { checkPath: canon(STANDALONE_PROJECT), projectRoot: canon(STANDALONE_PROJECT) },
    ]);
  });

  it('bounds the non-git climb to a known root instead of the start dir', async () => {
    mockGitResponses({ 'rev-parse --show-toplevel': null });

    const paths = await resolveLookupPaths(`${STANDALONE_PROJECT}/src`, [STANDALONE_PROJECT]);

    expect(paths).toEqual([
      {
        checkPath: canon(`${STANDALONE_PROJECT}/src`),
        projectRoot: canon(`${STANDALONE_PROJECT}/src`),
      },
      { checkPath: canon(STANDALONE_PROJECT), projectRoot: canon(STANDALONE_PROJECT) },
    ]);
  });

  it('bounds to the shallowest matching known root, given an un-deduplicated nested chain', async () => {
    mockGitResponses({ 'rev-parse --show-toplevel': null });
    const nested = `${STANDALONE_PROJECT}/deep`;

    const paths = await resolveLookupPaths(`${nested}/src`, [nested, STANDALONE_PROJECT]);

    expect(paths).toEqual([
      { checkPath: canon(`${nested}/src`), projectRoot: canon(`${nested}/src`) },
      { checkPath: canon(nested), projectRoot: canon(nested) },
      { checkPath: canon(STANDALONE_PROJECT), projectRoot: canon(STANDALONE_PROJECT) },
    ]);
  });

  it('bounds to a known root even when a directory name merely starts with ".."', async () => {
    mockGitResponses({ 'rev-parse --show-toplevel': null });
    const dotDir = `${STANDALONE_PROJECT}/..cache`;

    const paths = await resolveLookupPaths(`${dotDir}/src`, [STANDALONE_PROJECT]);

    expect(paths).toEqual([
      { checkPath: canon(`${dotDir}/src`), projectRoot: canon(`${dotDir}/src`) },
      { checkPath: canon(dotDir), projectRoot: canon(dotDir) },
      { checkPath: canon(STANDALONE_PROJECT), projectRoot: canon(STANDALONE_PROJECT) },
    ]);
  });

  it('falls back to the start dir itself when no known root is an ancestor', async () => {
    mockGitResponses({ 'rev-parse --show-toplevel': null });

    const paths = await resolveLookupPaths(STANDALONE_PROJECT, ['/unrelated/root']);

    expect(paths).toEqual([
      { checkPath: canon(STANDALONE_PROJECT), projectRoot: canon(STANDALONE_PROJECT) },
    ]);
  });

  it('climbs only up to the repo root on the main working tree', async () => {
    mockGitResponses({
      'rev-parse --show-toplevel': `${MAIN}\n`,
      'worktree list --porcelain': `worktree ${MAIN}\n`,
    });

    const paths = await resolveLookupPaths(`${NESTED}/src`);

    expect(paths).toEqual([
      { checkPath: canon(`${NESTED}/src`), projectRoot: canon(`${NESTED}/src`) },
      { checkPath: canon(NESTED), projectRoot: canon(NESTED) },
      { checkPath: canon(`${MAIN}/packages`), projectRoot: canon(`${MAIN}/packages`) },
      { checkPath: canon(MAIN), projectRoot: canon(MAIN) },
    ]);
  });

  it('appends the main-tree-equivalent climb when invoked from a linked worktree, reporting projectRoot in the current worktree', async () => {
    mockGitResponses({
      'rev-parse --show-toplevel': `${WORKTREE}\n`,
      'worktree list --porcelain': `worktree ${MAIN}\nworktree ${WORKTREE}\n`,
    });

    const paths = await resolveLookupPaths(`${WORKTREE}/src`);

    expect(paths).toEqual([
      { checkPath: canon(`${WORKTREE}/src`), projectRoot: canon(`${WORKTREE}/src`) },
      { checkPath: canon(WORKTREE), projectRoot: canon(WORKTREE) },
      { checkPath: canon(`${MAIN}/src`), projectRoot: canon(`${WORKTREE}/src`) },
      { checkPath: canon(MAIN), projectRoot: canon(WORKTREE) },
    ]);
  });

  it('still appends the main-tree climb from a directory name that merely starts with ".."', async () => {
    mockGitResponses({
      'rev-parse --show-toplevel': `${WORKTREE}\n`,
      'worktree list --porcelain': `worktree ${MAIN}\nworktree ${WORKTREE}\n`,
    });

    const paths = await resolveLookupPaths(`${WORKTREE}/..config`);

    expect(paths).toEqual([
      { checkPath: canon(`${WORKTREE}/..config`), projectRoot: canon(`${WORKTREE}/..config`) },
      { checkPath: canon(WORKTREE), projectRoot: canon(WORKTREE) },
      { checkPath: canon(`${MAIN}/..config`), projectRoot: canon(`${WORKTREE}/..config`) },
      { checkPath: canon(MAIN), projectRoot: canon(WORKTREE) },
    ]);
  });

  it('does not append a second climb when the current worktree is already the main one', async () => {
    mockGitResponses({
      'rev-parse --show-toplevel': `${MAIN}\n`,
      'worktree list --porcelain': `worktree ${MAIN}\nworktree ${WORKTREE}\n`,
    });

    const paths = await resolveLookupPaths(`${MAIN}/src`);

    expect(paths).toEqual([
      { checkPath: canon(`${MAIN}/src`), projectRoot: canon(`${MAIN}/src`) },
      { checkPath: canon(MAIN), projectRoot: canon(MAIN) },
    ]);
  });
});

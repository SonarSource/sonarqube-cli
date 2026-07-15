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

// Unit tests for the shared worktree-aware feature-selection policy. Exercises the
// pure selectFeatureForLookupPaths so the ranking (targetRoot before repoRoot,
// current worktree before main, nearest ancestor, then recency) is covered
// without spawning git. Paths are absolute and non-existent so canonicalizePath
// falls back to a deterministic path.resolve() on every platform.

import { describe, expect, it } from 'bun:test';

import {
  type RecordedFeatureCandidate,
  selectFeatureForLookupPaths,
} from '../../../../src/lib/project-workspace/recorded-feature-resolver';

const BASE = '/nonexistent-sqcli-resolver-test';
const MAIN = `${BASE}/main`;
const WORKTREE = `${BASE}/linked-worktree`;
const NESTED = `${MAIN}/packages/api`;
const OUTSIDE = `${BASE}/unrelated`;

function candidate(
  id: string,
  opts: { targetRoot: string; repoRoot?: string; updatedAt?: string },
): RecordedFeatureCandidate<string> {
  return { feature: id, ...opts };
}

describe('selectFeatureForLookupPaths', () => {
  it('prefers a targetRoot match over a more recent repoRoot-only match', () => {
    const candidates = [
      // Sibling worktree: matches only via repoRoot, updated later.
      candidate('sibling', {
        targetRoot: WORKTREE,
        repoRoot: MAIN,
        updatedAt: '2026-02-01T00:00:00.000Z',
      }),
      // Installed right here: exact targetRoot match, updated earlier.
      candidate('here', {
        targetRoot: MAIN,
        repoRoot: MAIN,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ];

    expect(selectFeatureForLookupPaths(candidates, [MAIN])).toBe('here');
  });

  it('prefers the current worktree over the main working tree', () => {
    const candidates = [
      candidate('main', { targetRoot: MAIN, repoRoot: MAIN }),
      candidate('worktree', { targetRoot: WORKTREE, repoRoot: MAIN }),
    ];

    // Lookup order is current-worktree-first, then main.
    expect(selectFeatureForLookupPaths(candidates, [WORKTREE, MAIN])).toBe('worktree');
  });

  it('falls back to the main working tree when the current worktree has no integration', () => {
    const candidates = [candidate('main', { targetRoot: MAIN, repoRoot: MAIN })];

    expect(selectFeatureForLookupPaths(candidates, [WORKTREE, MAIN])).toBe('main');
  });

  it('matches via repoRoot when targetRoot points at a different worktree', () => {
    const candidates = [candidate('sibling', { targetRoot: WORKTREE, repoRoot: MAIN })];

    expect(selectFeatureForLookupPaths(candidates, [MAIN])).toBe('sibling');
  });

  it('prefers the nearest ancestor (longest targetRoot) for nested integrations', () => {
    const candidates = [
      candidate('root', { targetRoot: MAIN }),
      candidate('nested', { targetRoot: NESTED }),
    ];

    expect(selectFeatureForLookupPaths(candidates, [`${NESTED}/src`])).toBe('nested');
    // Outside the nested subtree, the repo-root integration still wins.
    expect(selectFeatureForLookupPaths(candidates, [`${MAIN}/lib`])).toBe('root');
  });

  it('breaks ties on the same root by most recent update', () => {
    const candidates = [
      candidate('old', { targetRoot: MAIN, updatedAt: '2026-01-01T00:00:00.000Z' }),
      candidate('new', { targetRoot: MAIN, updatedAt: '2026-02-01T00:00:00.000Z' }),
    ];

    expect(selectFeatureForLookupPaths(candidates, [MAIN])).toBe('new');
  });

  it('matches a feature recorded at an ancestor directory (subdirectory invocation)', () => {
    const candidates = [candidate('root', { targetRoot: MAIN })];

    expect(selectFeatureForLookupPaths(candidates, [`${MAIN}/deep/sub`])).toBe('root');
  });

  it('treats a directory whose name starts with ".." as inside, not a parent traversal', () => {
    const candidates = [candidate('root', { targetRoot: MAIN })];

    // `..config` is a real child of MAIN, not a `../` escape: as a canonical path
    // it stays under MAIN (`.../main/..config` starts with `.../main/`) and must
    // not be mistaken for a leading `..` segment.
    expect(selectFeatureForLookupPaths(candidates, [`${MAIN}/..config`])).toBe('root');
  });

  it('returns undefined when a candidate is a sibling whose name starts with ".."', () => {
    const candidates = [candidate('main', { targetRoot: MAIN })];

    // `${BASE}/..evil` is a sibling of MAIN, not under it, so it must not match.
    expect(selectFeatureForLookupPaths(candidates, [`${BASE}/..evil`])).toBeUndefined();
  });

  it('returns undefined when no candidate contains the directory', () => {
    const candidates = [candidate('main', { targetRoot: MAIN, repoRoot: MAIN })];

    expect(selectFeatureForLookupPaths(candidates, [OUTSIDE])).toBeUndefined();
  });

  it('returns undefined when there are no candidates', () => {
    expect(selectFeatureForLookupPaths<string>([], [MAIN])).toBeUndefined();
  });
});

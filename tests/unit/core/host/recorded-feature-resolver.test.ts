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

// Unit tests for the pure exact-match selection policy over an already-expanded,
// nearest-first lookup-path list.

import { describe, expect, it } from 'bun:test';

import {
  type RecordedFeatureCandidate,
  selectFeatureForLookupPaths,
} from '@/core/host/recorded-feature-resolver.ts';

const MAIN = '/repo';
const MAIN_SUBDIR = `${MAIN}/src`;
const WORKTREE = '/repo-worktrees/feature-x';
const OUTSIDE = '/unrelated-project';

function candidate(
  id: string,
  opts: { targetRoot: string; repoRoot?: string; updatedAt?: string },
): RecordedFeatureCandidate<string> {
  return { feature: id, ...opts };
}

describe('selectFeatureForLookupPaths', () => {
  it('prefers a targetRoot match over a more recent repoRoot-only match at the same path', () => {
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

    expect(
      selectFeatureForLookupPaths(candidates, [{ checkPath: MAIN, projectRoot: MAIN }]),
    ).toEqual({
      feature: 'here',
      matchedPath: MAIN,
    });
  });

  it('checks lookup paths in order, so the current worktree wins when listed before the main tree', () => {
    const candidates = [
      candidate('main', { targetRoot: MAIN, repoRoot: MAIN }),
      candidate('worktree', { targetRoot: WORKTREE, repoRoot: MAIN }),
    ];

    expect(
      selectFeatureForLookupPaths(candidates, [
        { checkPath: WORKTREE, projectRoot: WORKTREE },
        // Translated main-tree entry: from inside WORKTREE, this always anchors
        // back to WORKTREE, never to MAIN itself.
        { checkPath: MAIN, projectRoot: WORKTREE },
      ]),
    ).toEqual({
      feature: 'worktree',
      matchedPath: WORKTREE,
    });
  });

  it('falls through to a later path when an earlier one has no match', () => {
    const candidates = [candidate('main', { targetRoot: MAIN, repoRoot: MAIN })];

    // Plain climb within one worktree, from a subdirectory up to the repo root.
    expect(
      selectFeatureForLookupPaths(candidates, [
        { checkPath: MAIN_SUBDIR, projectRoot: MAIN_SUBDIR },
        { checkPath: MAIN, projectRoot: MAIN },
      ]),
    ).toEqual({
      feature: 'main',
      matchedPath: MAIN,
    });
  });

  it('matches via repoRoot when targetRoot points at a different worktree', () => {
    const candidates = [candidate('sibling', { targetRoot: WORKTREE, repoRoot: MAIN })];

    expect(
      selectFeatureForLookupPaths(candidates, [{ checkPath: MAIN, projectRoot: MAIN }]),
    ).toEqual({
      feature: 'sibling',
      matchedPath: MAIN,
    });
  });

  it('reports projectRoot, not checkPath, when matched via a translated main-tree entry', () => {
    const candidates = [candidate('via-main-tree', { targetRoot: MAIN, repoRoot: MAIN })];

    expect(
      selectFeatureForLookupPaths(candidates, [
        { checkPath: WORKTREE, projectRoot: WORKTREE },
        { checkPath: MAIN, projectRoot: WORKTREE },
      ]),
    ).toEqual({
      feature: 'via-main-tree',
      matchedPath: WORKTREE,
    });
  });

  it('breaks ties on the same root by most recent update', () => {
    const candidates = [
      candidate('old', { targetRoot: MAIN, updatedAt: '2026-01-01T00:00:00.000Z' }),
      candidate('new', { targetRoot: MAIN, updatedAt: '2026-02-01T00:00:00.000Z' }),
    ];

    expect(
      selectFeatureForLookupPaths(candidates, [{ checkPath: MAIN, projectRoot: MAIN }])?.feature,
    ).toBe('new');
  });

  it('returns undefined when no candidate matches any lookup path', () => {
    const candidates = [candidate('main', { targetRoot: MAIN, repoRoot: MAIN })];

    expect(
      selectFeatureForLookupPaths(candidates, [{ checkPath: OUTSIDE, projectRoot: OUTSIDE }]),
    ).toBeUndefined();
  });

  it('returns undefined when there are no candidates', () => {
    expect(
      selectFeatureForLookupPaths<string>([], [{ checkPath: MAIN, projectRoot: MAIN }]),
    ).toBeUndefined();
  });

  it('returns undefined when there are no lookup paths', () => {
    const candidates = [candidate('main', { targetRoot: MAIN })];

    expect(selectFeatureForLookupPaths(candidates, [])).toBeUndefined();
  });
});

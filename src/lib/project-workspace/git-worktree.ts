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

// Git worktree awareness: map a path inside a linked worktree back to the
// equivalent path in the repository's main working tree, so per-project state
// recorded by `sonar integrate` in the main checkout can still be found after a
// worktree is created (e.g. for SQAA project-key and CAG context lookups).

import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { spawnProcess } from '../process';

/**
 * Resolve a path to its real on-disk form. On Windows this normalizes 8.3 short
 * names (e.g. `RUNNER~1`) and drive-letter casing to the canonical long form, so
 * paths coming from different sources (git output vs `process.cwd()`) compare
 * equal. Falls back to `resolve()` when the path does not exist on disk.
 */
function canonicalize(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

interface WorktreeMapping {
  /** git top-level of the input path (the linked worktree root when inside one). */
  currentRoot: string;
  /** Main working tree root; differs from currentRoot only inside a linked worktree. */
  mainRoot: string;
}

async function runGitStdout(args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await spawnProcess('git', args, { cwd });
    if (result.exitCode === 0) {
      return result.stdout;
    }
  } catch {
    // git not installed, or `cwd` is not inside a repository — caller falls back.
  }
  return null;
}

/**
 * Resolve the absolute path of the repository's main working tree for the given
 * directory. `git worktree list` always reports the main working tree as its
 * first entry, which is the stable checkout where `sonar integrate` should key
 * per-project state (it outlives any linked worktree). Returns null when git is
 * unavailable or the directory is not inside a repository.
 */
export async function resolveMainWorktreeRoot(dir: string): Promise<string | null> {
  const listing = await runGitStdout(['worktree', 'list', '--porcelain'], dir);
  const firstEntry = listing
    ?.split('\n')
    .find((line) => line.startsWith('worktree '))
    ?.slice('worktree '.length)
    .trim();
  return firstEntry ? resolve(firstEntry) : null;
}

/**
 * Resolve the current git top-level and the repository's main working tree root
 * for the given directory. Both roots are canonicalized to their real on-disk
 * form so all downstream comparisons (the currentRoot/mainRoot equality guard,
 * `relative`, and the mapped path) operate on consistent forms. Returns null
 * when git is unavailable or the directory is not inside a repository; when not
 * inside a linked worktree, currentRoot equals mainRoot.
 */
async function resolveWorktreeMapping(dir: string): Promise<WorktreeMapping | null> {
  const topLevel = await runGitStdout(['rev-parse', '--show-toplevel'], dir);
  if (topLevel === null) {
    return null;
  }
  const currentRoot = canonicalize(topLevel.trim());
  const mainRoot = canonicalize((await resolveMainWorktreeRoot(dir)) ?? currentRoot);
  return { currentRoot, mainRoot };
}

/**
 * Given a filesystem `path` inside a git working tree, return the de-duplicated
 * list of equivalent paths to consult for per-project state lookups: `path`
 * itself, plus its equivalent inside the repository's main working tree when
 * `path` is inside a linked worktree. Order is [current, main].
 *
 * Falls back to `[path]` when git is unavailable, `path` is not inside a linked
 * worktree, or `path` is outside the current worktree root.
 */
export async function resolveWorktreeEquivalentPaths(path: string): Promise<string[]> {
  const mapping = await resolveWorktreeMapping(path);
  if (!mapping || mapping.currentRoot === mapping.mainRoot) {
    return [path];
  }

  // `currentRoot` is already canonical; canonicalize `path` too (it usually comes
  // from `process.cwd()`) so the in-worktree offset is computed between comparable
  // forms — on Windows the two can otherwise differ (8.3 short vs long path),
  // making a raw `relative` spuriously start with `..`.
  const rel = relative(mapping.currentRoot, canonicalize(path));
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return [path];
  }

  const mapped = rel === '' ? mapping.mainRoot : join(mapping.mainRoot, rel);
  return mapped === path ? [path] : [path, mapped];
}

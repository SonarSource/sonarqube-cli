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

// Shared git worktree helpers (repo root, current branch).

import { resolve } from 'node:path';

import { spawnProcess } from '../../../lib/process';

/**
 * Returns the repository top-level for `cwd`, or `undefined` when not in a repo
 * or git is unavailable.
 */
export async function resolveGitRepoRoot(cwd: string): Promise<string | undefined> {
  const out = await tryRunGit(['rev-parse', '--show-toplevel'], cwd);
  if (out === undefined) return undefined;
  return resolve(out.trim());
}

/**
 * Returns the current branch name for `cwd`, or `undefined` when not in a repo,
 * git is unavailable, or HEAD is detached (`git branch --show-current` is empty).
 */
export async function resolveCurrentGitBranch(cwd: string): Promise<string | undefined> {
  const repoRoot = await resolveGitRepoRoot(cwd);
  if (!repoRoot) return undefined;

  const branch = await tryRunGit(['branch', '--show-current'], repoRoot);
  if (branch === undefined) return undefined;
  const trimmed = branch.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function tryRunGit(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const result = await spawnProcess('git', args, { cwd });
    if (result.exitCode !== 0) return undefined;
    return result.stdout;
  } catch {
    return undefined;
  }
}

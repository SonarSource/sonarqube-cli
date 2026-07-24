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

// git pre-push callback handler — scans files in new commits for secrets.
// Replaces the shell logic that was previously embedded in the git hook script.

import { resolveAuth } from '@/core/host/auth-resolver.ts';
import { spawnProcess } from '@/core/process/process.ts';

import { runSecretsStage } from './git-pre-push-secrets.ts';
import { MissingDependenciesError, SECRETS_INACTIVE_UNAUTHENTICATED } from './hook-dependencies.ts';
import type { PushRef } from './stdin.ts';
import { readGitPushRefs } from './stdin.ts';

export const GIT_NULL_OID = '0000000000000000000000000000000000000000';

export async function gitPrePush(files: string[] = []): Promise<void> {
  const fileGroups = await getFileGroupsToScan(files);
  if (fileGroups === null) return;

  const auth = await resolveAuth().catch(() => null);
  if (!auth) {
    throw new MissingDependenciesError(SECRETS_INACTIVE_UNAUTHENTICATED);
  }

  for (const group of fileGroups) {
    await runSecretsStage(group, auth);
  }
}

async function getFileGroupsToScan(files: string[]): Promise<string[][] | null> {
  if (files.length > 0) {
    /*
     * pre-commit framework pre-chunks files before calling our tool in parallel.
     * This is suboptimal for SCA analysis, as it may be triggered multiple times for the same changes.
     * However, there's no easy solution, as the pre-commit framework can't pass all files at once due to ARG_MAX limits
     * and there's no support for stdin.
     */
    return [files];
  }

  const refs = await readGitPushRefs();
  if (refs.length === 0) return null;

  const emptyTree = await getEmptyTree();
  const nonDeletionRefs = refs.filter((ref) => ref.localSha !== GIT_NULL_OID);
  const filesByRef = await collectFilesForRefs(nonDeletionRefs, emptyTree);
  const groups = Array.from(filesByRef.values()).filter((g) => g.length > 0);
  return groups.length > 0 ? groups : null;
}

async function getEmptyTree(): Promise<string> {
  try {
    const result = await spawnProcess('git', ['mktree'], { stdin: 'pipe', stdinData: '' });
    return result.stdout.trim() || GIT_NULL_OID;
  } catch {
    return GIT_NULL_OID;
  }
}

async function collectFilesForRefs(
  refs: PushRef[],
  emptyTree: string,
): Promise<Map<PushRef, string[]>> {
  const out = new Map<PushRef, string[]>();
  for (const ref of refs) {
    out.set(ref, await getFilesForRef(ref, emptyTree));
  }
  return out;
}

async function getFilesForRef(ref: PushRef, emptyTree: string): Promise<string[]> {
  try {
    if (ref.remoteSha === GIT_NULL_OID) {
      return await getFilesForNewBranch(ref.localSha, emptyTree);
    }
    const result = await spawnProcess('git', [
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      ref.remoteSha,
      ref.localSha,
    ]);
    return result.stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function getFilesForNewBranch(localSha: string, emptyTree: string): Promise<string[]> {
  try {
    const commitsResult = await spawnProcess('git', ['rev-list', localSha, '--not', '--remotes']);
    const commits = commitsResult.stdout.trim().split('\n').filter(Boolean);

    if (commits.length > 0) {
      const fileSet = new Set<string>();
      for (const commit of commits) {
        const result = await spawnProcess('git', [
          'diff-tree',
          '--root',
          '--no-commit-id',
          '-r',
          '--name-only',
          '--diff-filter=ACMR',
          commit,
        ]);
        result.stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .forEach((f) => fileSet.add(f));
      }
      return Array.from(fileSet);
    }

    const result = await spawnProcess('git', [
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      emptyTree,
      localSha,
    ]);
    return result.stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

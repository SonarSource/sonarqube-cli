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

// git pre-push callback handler — scans files in new commits for secrets and,
// when --dependency-risks is set, runs a dependency-risks scan as a follow-up stage.
// Replaces the shell logic that was previously embedded in the git hook script.

import { resolveAuth } from '../../../lib/auth-resolver';
import { spawnProcess } from '../../../lib/process';
import { warn } from '../../../ui';
import { InvalidOptionError } from '../_common/error';
import { runDepRisksStage } from './git-pre-push-dependency-risks.ts';
import { runSecretsStage } from './git-pre-push-secrets.ts';
import type { PushRef } from './stdin';
import { readGitPushRefs } from './stdin';

export const GIT_NULL_OID = '0000000000000000000000000000000000000000';

export interface GitPrePushOptions {
  project?: string;
  dependencyRisks?: boolean;
}

export async function gitPrePush(
  options: GitPrePushOptions = {},
  files: string[] = [],
): Promise<void> {
  if (options.dependencyRisks && !options.project) {
    throw new InvalidOptionError('--dependency-risks requires -p <projectKey>.');
  }

  const auth = await resolveAuth().catch(() => null);
  if (!auth) return;

  const changedFiles = await getFilesToScan(files);
  if (changedFiles === null) return;

  if (await hasUncommittedChanges()) {
    warn(
      'Uncommitted changes detected — they are not part of this push but will be included in the scan.',
    );
  }

  await runSecretsStage(changedFiles, auth);

  if (options.dependencyRisks && options.project) {
    await runDepRisksStage({ project: options.project, changedFiles, auth });
  }
}

async function getFilesToScan(files: string[]) {
  if (files.length > 0) {
    return files;
  } else {
    const refs = await readGitPushRefs();
    if (refs.length === 0) return null;

    const emptyTree = await getEmptyTree();
    const nonDeletionRefs = refs.filter((ref) => ref.localSha !== GIT_NULL_OID);
    const filesByRef = await collectFilesForRefs(nonDeletionRefs, emptyTree);
    return [...new Set(Array.from(filesByRef.values()).flat())];
  }
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

export async function hasUncommittedChanges(): Promise<boolean> {
  try {
    const result = await spawnProcess('git', ['diff', '--quiet', 'HEAD']);
    return result.exitCode !== 0;
  } catch {
    return false;
  }
}

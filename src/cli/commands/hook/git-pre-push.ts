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

// git pre-push callback handler — scans files in new commits for secrets before push.
// Replaces the shell logic that was previously embedded in the git hook script.

import logger from '../../../lib/logger';
import { spawnProcess } from '../../../lib/process';
import { CommandFailedError } from '../_common/error';
import { EXIT_CODE_SECRETS_FOUND, runSecretsBinary } from '../analyze/secrets';
import { resolveAuthAndSecrets } from './hook-dependencies';
import type { PushRef } from './stdin';
import { readGitPushRefs } from './stdin';

const GIT_NULL_OID = '0000000000000000000000000000000000000000';

export async function gitPrePush(): Promise<void> {
  const refs = await readGitPushRefs();
  if (refs.length === 0) return;

  const deps = await resolveAuthAndSecrets();
  if (!deps) return;

  const emptyTree = await getEmptyTree();

  for (const ref of refs) {
    if (ref.localSha === GIT_NULL_OID) continue; // branch deletion — nothing to scan

    const files = await getFilesForRef(ref, emptyTree);
    if (files.length === 0) continue;

    try {
      const result = await runSecretsBinary(deps.binaryPath, files, deps.auth);
      const exitCode = result.exitCode ?? 1;
      if (exitCode === EXIT_CODE_SECRETS_FOUND) {
        throw new CommandFailedError('Secrets detected in pushed commits.', {
          remediationHint:
            'Remove the reported secret, amend the commit if needed, then retry the push.',
        });
      }
    } catch (err) {
      if (err instanceof CommandFailedError) throw err;
      logger.debug(`git pre-push secrets scan failed: ${(err as Error).message}`);
      throw new CommandFailedError('Secrets scan failed.', {
        remediationHint:
          "Run 'sonar integrate' again or run 'sonar analyze secrets -- <files>' manually to debug the analyzer.",
      });
    }
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

    // No other remotes — diff full branch against empty tree
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

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

// git pre-commit callback handler — scans staged files for secrets and,
// when --dependency-risks is set, runs a dependency-risks scan as a follow-up stage.
// Replaces the shell logic that was previously embedded in the git hook script.

import { resolveAuth } from '../../../lib/auth-resolver';
import { spawnProcess } from '../../../lib/process';
import { InvalidOptionError } from '../_common/error';
import { runDepRisksStage } from './git-pre-commit-dependency-risks.ts';
import { runCommitSecretsStage } from './git-pre-commit-secrets.ts';
import { MissingDependenciesError, SECRETS_INACTIVE_UNAUTHENTICATED } from './hook-dependencies.ts';

export interface GitPreCommitOptions {
  project?: string;
  dependencyRisks?: boolean;
}

export async function gitPreCommit(
  options: GitPreCommitOptions = {},
  files: string[] = [],
): Promise<void> {
  if (options.dependencyRisks && !options.project) {
    throw new InvalidOptionError('--dependency-risks requires -p <projectKey>.');
  }

  const stagedFiles = files.length > 0 ? files : await getStagedFiles();
  if (stagedFiles.length === 0) return;

  const auth = await resolveAuth().catch(() => null);
  if (!auth) {
    throw new MissingDependenciesError(SECRETS_INACTIVE_UNAUTHENTICATED);
  }

  await runCommitSecretsStage(stagedFiles, auth);

  if (options.dependencyRisks && options.project) {
    await runDepRisksStage({ project: options.project, changedFiles: stagedFiles, auth });
  }
}

async function getStagedFiles(): Promise<string[]> {
  try {
    const result = await spawnProcess('git', [
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=ACMR',
    ]);
    if (result.exitCode !== 0) return [];
    return result.stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

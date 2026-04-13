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

// git pre-commit callback handler — scans staged files for secrets before commit.
// Replaces the shell logic that was previously embedded in the git hook script.

import { resolveAuth } from '../../../lib/auth-resolver';
import logger from '../../../lib/logger';
import { spawnProcess } from '../../../lib/process';
import { resolveSecretsBinaryPath } from '../_common/install/secrets';
import { EXIT_CODE_SECRETS_FOUND, runSecretsBinary } from '../analyze/secrets';
import { CommandFailedError } from '../_common/error';

export async function gitPreCommit(): Promise<void> {
  const stagedFiles = await getStagedFiles();
  if (stagedFiles.length === 0) return;

  const auth = await resolveAuth().catch(() => null);
  if (!auth) return; // not authenticated — skip gracefully

  const binaryPath = resolveSecretsBinaryPath();
  if (!binaryPath) return; // binary not installed — skip gracefully

  try {
    const result = await runSecretsBinary(binaryPath, stagedFiles, auth);
    const exitCode = result.exitCode ?? 1;
    if (exitCode === EXIT_CODE_SECRETS_FOUND) {
      throw new CommandFailedError('Secrets detected in staged files');
    }
  } catch (err) {
    if (err instanceof CommandFailedError) throw err;
    logger.debug(`git pre-commit secrets scan failed: ${(err as Error).message}`);
    throw new CommandFailedError('Secrets scan failed');
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

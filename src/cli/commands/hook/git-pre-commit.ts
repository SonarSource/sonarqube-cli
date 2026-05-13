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

import logger from '../../../lib/logger';
import { spawnProcess } from '../../../lib/process';
import { print } from '../../../ui';
import { CommandFailedError } from '../_common/error';
import { EXIT_CODE_SECRETS_FOUND, runSecretsBinary } from '../analyze/secrets';
import { resolveAuthAndSecrets } from './hook-dependencies';

export async function gitPreCommit(): Promise<void> {
  const stagedFiles = await getStagedFiles();
  if (stagedFiles.length === 0) return;

  const deps = await resolveAuthAndSecrets();
  if (!deps) return;

  let result;
  try {
    result = await runSecretsBinary(deps.binaryPath, stagedFiles, deps.auth);
  } catch (err) {
    logger.debug(`git pre-commit secrets scan failed: ${(err as Error).message}`);
    throw new CommandFailedError('Secrets scan failed.', {
      remediationHint:
        "Run 'sonar integrate' again or run 'sonar analyze secrets -- <files>' manually to debug the analyzer.",
    });
  }

  if ((result.exitCode ?? 1) === EXIT_CODE_SECRETS_FOUND) {
    const output = [result.stderr, result.stdout].filter(Boolean).join('\n');
    if (output) print(output);
    throw new CommandFailedError('Secrets detected in staged files.', {
      remediationHint: 'Remove the reported secret, then retry the commit.',
    });
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

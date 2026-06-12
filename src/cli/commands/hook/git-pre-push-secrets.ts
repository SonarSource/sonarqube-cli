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

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import { CommandFailedError } from '../_common/error';
import { resolveSecretsBinaryPath } from '../_common/install/secrets';
import { EXIT_CODE_SECRETS_FOUND, runSecretsBinary } from '../analyze/secrets';
import { handleScanError } from './hook-dependencies';

export async function runSecretsStage(files: string[], auth: ResolvedAuth): Promise<void> {
  const binaryPath = resolveSecretsBinaryPath();
  if (!binaryPath) return;
  if (files.length === 0) return;

  let result;
  try {
    result = await runSecretsBinary(binaryPath, files, auth);
  } catch (err) {
    handleScanError('Push', err as Error);
    return;
  }

  if ((result.exitCode ?? 1) === EXIT_CODE_SECRETS_FOUND) {
    throw new CommandFailedError('Secrets detected in pushed commits.', {
      remediationHint:
        'Remove the reported secret, amend the commit if needed, then retry the push.',
    });
  }
}

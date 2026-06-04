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
import { GIT_NULL_OID } from './git-pre-push';
import type { HookDependencies } from './hook-dependencies';
import { handleScanError } from './hook-dependencies';
import type { PushRef } from './stdin';

export async function runSecretsStage(
  filesByRef: Map<PushRef, string[]>,
  auth: ResolvedAuth,
): Promise<void> {
  const binaryPath = resolveSecretsBinaryPath();
  if (!binaryPath) return;
  const deps: HookDependencies = { auth, binaryPath };

  for (const [ref, files] of filesByRef) {
    if (ref.localSha === GIT_NULL_OID) continue;
    if (files.length === 0) continue;
    await scanRef(files, deps);
  }
}

async function scanRef(files: string[], deps: HookDependencies): Promise<void> {
  try {
    const result = await runSecretsBinary(deps.binaryPath, files, deps.auth);
    if ((result.exitCode ?? 1) === EXIT_CODE_SECRETS_FOUND) {
      throw new CommandFailedError('Secrets detected in pushed commits.', {
        remediationHint:
          'Remove the reported secret, amend the commit if needed, then retry the push.',
      });
    }
  } catch (err) {
    if (err instanceof CommandFailedError) throw err;
    handleScanError('Push', err as Error);
  }
}

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
import { SECRETS_CALLER_COMMANDS } from '../../../telemetry/secrets-analysis-telemetry.js';
import { CommandFailedError } from '../_common/error';
import { resolveSecretsBinaryPath } from '../_common/install/secrets';
import {
  EXIT_CODE_SECRETS_FOUND,
  runSecretsBinary,
  scanAndEmitSecrets,
  warnScanErrors,
} from '../analyze/secrets';
import {
  handleScanError,
  MissingDependenciesError,
  SECRETS_INACTIVE_BINARY_MISSING,
} from './hook-dependencies';

export async function runSecretsStage(files: string[], auth: ResolvedAuth): Promise<void> {
  if (files.length === 0) return;
  const binaryPath = resolveSecretsBinaryPath();
  if (!binaryPath) {
    throw new MissingDependenciesError(SECRETS_INACTIVE_BINARY_MISSING);
  }

  let scan: Awaited<ReturnType<typeof scanAndEmitSecrets>>;
  try {
    scan = await scanAndEmitSecrets(SECRETS_CALLER_COMMANDS.gitPrePush, auth, () =>
      runSecretsBinary(binaryPath, files, auth),
    );
  } catch (err) {
    handleScanError('Push', err as Error);
    return;
  }

  const { result, parsed } = scan;
  warnScanErrors(parsed.errors);

  if ((result.exitCode ?? 1) === EXIT_CODE_SECRETS_FOUND) {
    throw new CommandFailedError('Secrets detected in pushed commits.', {
      remediationHint:
        'Remove the reported secret, amend the commit if needed, then retry the push.',
    });
  }
}

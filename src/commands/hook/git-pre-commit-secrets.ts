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

import type { CommandInvocationContext } from '@/commands/command-invocation-context.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import { resolveSecretsBinaryPath } from '@/core/host/install/secrets.ts';
import { SECRETS_CALLER_COMMANDS } from '@/core/telemetry/secrets-analysis-telemetry.ts';

import {
  EXIT_CODE_SECRETS_FOUND,
  runSecretsBinary,
  scanAndEmitSecrets,
  warnScanErrors,
} from '../analyze/secrets.ts';
import {
  handleScanError,
  MissingDependenciesError,
  SECRETS_INACTIVE_BINARY_MISSING,
} from './hook-dependencies.ts';
import { printSecretsFindingsOrStderr } from './secrets-display.ts';

export async function runCommitSecretsStage(
  files: string[],
  auth: ResolvedAuth,
  ctx: CommandInvocationContext,
): Promise<void> {
  const binaryPath = resolveSecretsBinaryPath();
  if (!binaryPath) {
    throw new MissingDependenciesError(SECRETS_INACTIVE_BINARY_MISSING);
  }

  let scan: Awaited<ReturnType<typeof scanAndEmitSecrets>>;
  try {
    scan = await scanAndEmitSecrets(
      SECRETS_CALLER_COMMANDS.gitPreCommit,
      auth,
      () => runSecretsBinary(binaryPath, files, auth),
      ctx,
    );
  } catch (err) {
    handleScanError('Commit', err as Error);
    return;
  }

  const { result, parsed } = scan;
  const { issues, errors } = parsed;
  warnScanErrors(errors);

  if ((result.exitCode ?? 1) === EXIT_CODE_SECRETS_FOUND) {
    printSecretsFindingsOrStderr(issues, result.stderr);
    throw new CommandFailedError('Secrets detected in staged files.', {
      remediationHint: 'Remove the reported secret, then retry the commit.',
    });
  }
}

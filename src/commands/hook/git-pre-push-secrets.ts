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

import { scanAndEmitSecrets } from '@/commands/analyze/secrets-analysis-telemetry.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { EXIT_CODE_SECRETS_FOUND, SECRETS_CALLER_COMMANDS } from '@/core/config-constants.ts';
import { resolveSecretsBinaryPath } from '@/core/host/install/secrets.ts';
import type { SpawnResult } from '@/core/process/process.ts';

import type { SecretsJsonIssue } from '../analyze/secrets.ts';
import { runSecretsBinary, runSecretsBinaryOnBatch, warnScanErrors } from '../analyze/secrets.ts';
import {
  handleScanError,
  MissingDependenciesError,
  SECRETS_INACTIVE_BINARY_MISSING,
} from './hook-dependencies.ts';
import { printSecretsFindingsOrStderr } from './secrets-display.ts';

/** The outcome of one scan. `secretsFound` comes from the exit code, so it holds even when no issue parses. */
export interface BatchScanOutcome {
  secretsFound: boolean;
  issues: SecretsJsonIssue[];
  stderr: string;
}

/** Scans paths as they exist in the working tree. Used when the caller gives us filenames but no commits. */
export async function runSecretsStage(
  files: string[],
  auth: ResolvedAuth,
  ctx: CommandInvocationContext,
): Promise<void> {
  if (files.length === 0) return;
  const outcome = await runScan(
    (binaryPath) => runSecretsBinary(binaryPath, files, auth),
    auth,
    ctx,
  );
  if (outcome?.secretsFound) {
    printSecretsFindingsOrStderr(outcome.issues, outcome.stderr, ctx.console);
    throw new CommandFailedError('Secrets detected in pushed commits.', {
      remediationHint:
        'Remove the reported secret, amend the commit if needed, then retry the push.',
    });
  }
}

/**
 * Scans one encoded batch. Returns its findings, or `null` when the scan itself could not run — which is reported and
 * then allowed through, matching how the hook has always treated an analyzer failure.
 */
export async function scanBatch(
  batch: Buffer,
  auth: ResolvedAuth,
  ctx: CommandInvocationContext,
): Promise<BatchScanOutcome | null> {
  return runScan((binaryPath) => runSecretsBinaryOnBatch(binaryPath, batch, auth), auth, ctx);
}

async function runScan(
  run: (binaryPath: string) => Promise<SpawnResult>,
  auth: ResolvedAuth,
  ctx: CommandInvocationContext,
): Promise<BatchScanOutcome | null> {
  const binaryPath = resolveSecretsBinaryPath();
  if (!binaryPath) {
    throw new MissingDependenciesError(SECRETS_INACTIVE_BINARY_MISSING);
  }

  let scan: Awaited<ReturnType<typeof scanAndEmitSecrets>>;
  try {
    scan = await scanAndEmitSecrets(
      SECRETS_CALLER_COMMANDS.gitPrePush,
      auth,
      () => run(binaryPath),
      ctx,
    );
  } catch (err) {
    handleScanError('Push', err as Error, auth, ctx.console);
    return null;
  }

  const { result, parsed } = scan;
  warnScanErrors(ctx.console, parsed.errors);
  return {
    secretsFound: (result.exitCode ?? 1) === EXIT_CODE_SECRETS_FOUND,
    issues: parsed.issues,
    stderr: result.stderr,
  };
}

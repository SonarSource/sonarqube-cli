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

import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { ResolvedAuth } from '@/core/host/auth-resolver.ts';
import logger from '@/core/observability/logger.ts';
import { SECRETS_CALLER_COMMANDS } from '@/core/telemetry/secrets-analysis-telemetry.ts';
import { withSpinner } from '@/core/ui';

import { CommandFailedError } from '../../_common/error.ts';
import { formatSpawnOutput } from '../../_common/install/install-utils.ts';
import type { ScaScannerInstaller } from '../../_common/install/sca-scanner.ts';
import type { SecretsInstaller } from '../../_common/install/secrets.ts';
import type { SecretsJsonIssue } from '../secrets.ts';
import {
  EXIT_CODE_SECRETS_FOUND,
  runSecretsBinary,
  scanAndEmitSecrets,
  warnScanErrors,
} from '../secrets.ts';
import { ScaDiscoverManifestsRunner } from './sca-discover-manifests.ts';
import type { ScaScannerInvocation } from './sca-scanner-runner-base.ts';
import type { ScaScannerSpawner } from './sca-scanner-spawner.ts';

/**
 * Discovers dependency manifests and scans them for secrets before SCA analysis.
 */
export async function preScanManifestsForSecrets(deps: {
  invocation: ScaScannerInvocation;
  baseDir: string;
  auth: ResolvedAuth;
  scaInstaller: ScaScannerInstaller;
  scaSpawner: ScaScannerSpawner;
  secretsInstaller: SecretsInstaller;
}): Promise<void> {
  const { invocation, baseDir, auth, scaInstaller, scaSpawner, secretsInstaller } = deps;
  const discoverInvocation: ScaScannerInvocation = {
    ...invocation,
    workDir: join(tmpdir(), `sonar-sca-discover-${Date.now()}`),
  };
  const manifestFiles = await new ScaDiscoverManifestsRunner(scaInstaller, scaSpawner).run(
    discoverInvocation,
  );
  const resolvedFiles = manifestFiles.map((file) =>
    isAbsolute(file) ? file : join(baseDir, file),
  );
  await scanManifestsForSecrets(resolvedFiles, auth, secretsInstaller);
}

/**
 * Scans the given files for secrets via sonar-secrets.
 */
async function scanManifestsForSecrets(
  files: string[],
  auth: ResolvedAuth,
  installer: SecretsInstaller,
): Promise<void> {
  if (files.length === 0) {
    return;
  }

  const binaryPath = await installer.install();
  if (!binaryPath) {
    logger.debug('manifest-secrets-guard: sonar-secrets not available, skipping secrets check');
    return;
  }

  // Spawn error propagate so the callers decide what it means
  // (the command aborts; the hook's wrapper turns it into a non-blocking warning).
  // scanAndEmitSecrets emits a failures_count:1 event before re-throwing on a failed run.
  const { result, parsed } = await scanAndEmitSecrets(
    SECRETS_CALLER_COMMANDS.analyzeDependencyRisks,
    auth,
    () =>
      withSpinner(
        'Scanning manifests for secrets',
        () => runSecretsBinary(binaryPath, files, auth),
        'stderr',
      ),
  );
  const { issues, errors } = parsed;
  const exitCode = result.exitCode ?? 1;

  if (exitCode === EXIT_CODE_SECRETS_FOUND) {
    const findings = formatSecretFindings(issues);
    const message = findings
      ? `Secrets detected in dependency manifest files. Dependency risks analysis aborted.\n\n${findings}`
      : `Secrets detected in dependency manifest files. Dependency risks analysis aborted.`;
    warnScanErrors(errors);
    throw new CommandFailedError(message, {
      remediationHint:
        "Remove the reported secret from the manifest file, then rerun 'sonar analyze dependency-risks'.",
    });
  }

  if (exitCode !== 0) {
    throw new CommandFailedError(
      `Secrets scan of dependency manifests failed (exit code ${String(exitCode)}).\n` +
        formatSpawnOutput(result.stdout, result.stderr),
    );
  }

  warnScanErrors(errors);
}

/**
 * Renders one line per detected secret, e.g.:
 *   • package.json:12 — AWS Access Key detected (secret: AKIA****)
 */
function formatSecretFindings(issues: SecretsJsonIssue[]): string {
  return issues
    .map((issue) => {
      const location = issue.location ? `:${String(issue.location.startLine)}` : '';
      const message = issue.description ? ` — ${issue.description}` : '';
      const secret = issue.maskedSecret ? ` (secret: ${issue.maskedSecret})` : '';
      return `  • ${issue.file ?? '(unknown)'}${location}${message}${secret}`;
    })
    .join('\n');
}

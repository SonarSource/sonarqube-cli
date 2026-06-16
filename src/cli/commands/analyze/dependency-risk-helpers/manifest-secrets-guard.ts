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

import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import logger from '../../../../lib/logger';
import { withSpinner } from '../../../../ui';
import { CommandFailedError } from '../../_common/error';
import { formatSpawnOutput } from '../../_common/install/install-utils';
import type { ScaScannerInstaller } from '../../_common/install/sca-scanner';
import type { SecretsInstaller } from '../../_common/install/secrets';
import { EXIT_CODE_SECRETS_FOUND, runSecretsBinary } from '../secrets';
import { parseSecretsOutput, type SecretsIssue } from '../secrets-output';
import { ScaDiscoverManifestsRunner } from './sca-discover-manifests';
import type { ScaScannerInvocation } from './sca-scanner-runner-base';
import type { ScaScannerSpawner } from './sca-scanner-spawner';

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
  await scaInstaller.install(); // up front so its download spinners don't nest inside the discovery spinner
  const manifestFiles = await withSpinner(
    'Discovering dependency manifests',
    () => new ScaDiscoverManifestsRunner(scaInstaller, scaSpawner).run(discoverInvocation),
    process.stderr,
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
  const result = await withSpinner(
    'Scanning manifests for secrets',
    () => runSecretsBinary(binaryPath, files, auth),
    process.stderr,
  );
  const exitCode = result.exitCode ?? 1;

  if (exitCode === EXIT_CODE_SECRETS_FOUND) {
    const findings = formatSecretFindings(parseSecretsOutput(result.stdout));
    throw new CommandFailedError(
      `Secrets detected in dependency manifest files. Dependency risks analysis aborted.\n\n${findings}`,
      {
        remediationHint:
          "Remove the reported secret from the manifest file, then rerun 'sonar analyze dependency-risks'.",
      },
    );
  }

  if (exitCode !== 0) {
    throw new CommandFailedError(
      `Secrets scan of dependency manifests failed (exit code ${String(exitCode)}).\n` +
        formatSpawnOutput(result.stdout, result.stderr),
    );
  }
}

/**
 * Renders one line per detected secret, e.g.:
 *   • package.json:12 — AWS Access Key detected (secret: AKIA****)
 */
function formatSecretFindings(issues: SecretsIssue[]): string {
  return issues
    .map((issue) => {
      const location = issue.location ? `:${String(issue.location.startLine)}` : '';
      const message = issue.message ? ` — ${issue.message}` : '';
      const secret = issue.secret ? ` (secret: ${issue.secret})` : '';
      return `  • ${issue.file}${location}${message}${secret}`;
    })
    .join('\n');
}

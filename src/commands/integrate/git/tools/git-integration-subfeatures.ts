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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import {
  scaScannerBinaryDependency,
  sonarSecretsBinaryDependency,
} from '@/core/framework/dependencies';
import { install, skip } from '@/core/framework/features/selection.ts';
import type { FeaturePreview, SubfeatureDeclaration } from '@/core/framework/features/types.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import { assertScaAvailable } from '@/core/server/sca-availability.ts';

import type { GitHookType, IntegrateGitOptions } from '../options.ts';

export const PRE_COMMIT_DEP_RISKS_SUBFEATURE_ID = 'pre-commit-dependency-risks';

export function gitHookPreview(hook: GitHookType): FeaturePreview {
  return (activeSubfeatureIds) => {
    const event = hook === 'pre-push' ? 'push' : 'commit';
    const scansDependencies = activeSubfeatureIds.includes(PRE_COMMIT_DEP_RISKS_SUBFEATURE_ID);
    const target = scansDependencies
      ? 'files for secrets and checks dependencies for known vulnerabilities (SCA)'
      : 'files for secrets';
    return `Scans ${target} before each ${event}. Works independently of any AI agent.`;
  };
}

async function scaSkipReason(auth: ResolvedAuth) {
  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  try {
    await assertScaAvailable(client, auth);
    return null;
  } catch (err) {
    if (err instanceof CommandFailedError) {
      return skip(err.message);
    }
    throw err;
  }
}

export function createSecretsSubfeature(): SubfeatureDeclaration<IntegrateGitOptions> {
  return {
    id: 'pre-commit-secrets',
    displayName: 'pre-commit secrets scan',
    shouldInstall: () =>
      install('Secrets scan is required for other hook types and is enabled by default'),
    dependencies: [sonarSecretsBinaryDependency],
  };
}

export function createDepRisksSubfeature(): SubfeatureDeclaration<IntegrateGitOptions> {
  return {
    id: PRE_COMMIT_DEP_RISKS_SUBFEATURE_ID,
    displayName: 'pre-commit dependency-risks scan',
    // Installed by default when SCA is available. Project key is optional; unresolved
    // falls back to discoverProject() at hook run time.
    shouldInstall: async ({ auth }) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const skipDecision = await scaSkipReason(auth!);
      return skipDecision ?? install();
    },
    dependencies: [sonarSecretsBinaryDependency, scaScannerBinaryDependency],
  };
}

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
import { CommandFailedError } from '@/core/commands/command-error.ts';
import {
  scaScannerBinaryDependency,
  sonarSecretsBinaryDependency,
} from '@/core/framework/dependencies';
import type {
  FeatureAvailability,
  FeaturePreview,
  SubfeatureDeclaration,
} from '@/core/framework/features/types.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { ScaClient } from '@/core/server/sca.ts';
import {
  assertScaAvailable,
  ScaServerVersionUnknownError,
} from '@/core/server/sca-availability.ts';

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

async function scaAvailability(auth: ResolvedAuth): Promise<FeatureAvailability> {
  const client = new ScaClient(new SonarHttpClient(auth.serverUrl, auth.token));
  try {
    await assertScaAvailable(
      { checkScaEnabled: (ct, orgKey) => client.checkScaEnabled(ct, orgKey).orThrow() },
      auth,
    );
    return { available: true };
  } catch (err) {
    if (err instanceof CommandFailedError && !(err instanceof ScaServerVersionUnknownError)) {
      return {
        available: false,
        unavailableReason: [err.message, err.remediationHint].filter(Boolean).join(' '),
      };
    }
    return { available: undefined };
  }
}

export function createSecretsSubfeature(): SubfeatureDeclaration<IntegrateGitOptions> {
  return {
    id: 'pre-commit-secrets',
    displayName: 'pre-commit secrets scan',
    required: true,
    dependencies: [sonarSecretsBinaryDependency],
  };
}

export function createDepRisksSubfeature(): SubfeatureDeclaration<IntegrateGitOptions> {
  return {
    id: PRE_COMMIT_DEP_RISKS_SUBFEATURE_ID,
    displayName: 'pre-commit dependency-risks scan',
    // Project key is optional; unresolved falls back to discoverProject() at hook run time.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    isAvailable: ({ auth }) => scaAvailability(auth!),
    dependencies: [sonarSecretsBinaryDependency, scaScannerBinaryDependency],
  };
}

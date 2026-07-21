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

import { join } from 'node:path';

import type {
  FeatureContainer,
  FeatureDeclaration,
  IntegrationDeclaration,
} from '../../../_common/registry';
import {
  sonarSecretsBinaryDependency,
  yamlPatch,
  yamlPatchRemover,
} from '../../../_common/registry';
import type { GitHookType, IntegrateGitOptions } from '../../options.ts';
import {
  createDepRisksSubfeature,
  createSecretsSubfeature,
  gitHookPreview,
} from '../git-integration-subfeatures.ts';
import { gitCombinedHookExample, gitHookExample, shouldInstallHook } from '../shared.ts';
import {
  activatePreCommitFramework,
  garbageCollectPreCommitFramework,
  normalizePreCommitConfig,
  PRE_COMMIT_CONFIG_FILE,
  removeLegacyHook,
  removeLegacySonarHook,
  removeSonarHook,
  upsertSonarHook,
} from './config.ts';

export const PRE_COMMIT_INTEGRATION_ID = 'pre-commit';

export const preCommitIntegration: IntegrationDeclaration<IntegrateGitOptions> = {
  id: PRE_COMMIT_INTEGRATION_ID,
  displayName: 'pre-commit integration',
  features: [createPreCommitFeature('pre-commit'), createPreCommitFeature('pre-push')],
  combinedPostInstallExample: gitCombinedHookExample,
};

function createPreCommitFeature(
  hook: GitHookType,
): FeatureContainer<IntegrateGitOptions> | FeatureDeclaration<IntegrateGitOptions> {
  const base: FeatureDeclaration<IntegrateGitOptions> = {
    id: `${hook}-hook`,
    displayName: `${hook} code scanning hook`,
    previewDescription: gitHookPreview(hook),
    shouldInstall: ({ options }) => shouldInstallHook(hook, options),
    postInstallExample: gitHookExample(hook),
    resources: [
      yamlPatch({
        id: 'hook-config',
        version: '1',
        displayName: `${hook} hook`,
        targetPath: (context) => join(context.targetRoot, PRE_COMMIT_CONFIG_FILE),
        patch: (document, context) => {
          const config = normalizePreCommitConfig(document);
          upsertSonarHook(config, hook, context);
          return config;
        },
        removePatch: (document) => {
          const config = normalizePreCommitConfig(document);
          removeSonarHook(config, hook);
          return config;
        },
      }),
    ],
    operations: [
      {
        id: 'activate-hook',
        version: '1',
        displayName: `${hook} hook activation`,
        apply: ({ targetRoot }) => activatePreCommitFramework(targetRoot, hook),
        undo: ({ targetRoot }) => garbageCollectPreCommitFramework(targetRoot),
      },
    ],
    legacyCleanups: [
      yamlPatchRemover({
        id: 'hook-config',
        version: '0',
        targetPath: (context) => join(context.targetRoot, PRE_COMMIT_CONFIG_FILE),
        removePatch: (document) => {
          const config = normalizePreCommitConfig(document);
          removeLegacyHook(config);
          removeLegacySonarHook(config, hook);
          return config;
        },
      }),
    ],
  };

  if (hook === 'pre-commit') {
    return {
      ...base,
      subfeatures: [createSecretsSubfeature(), createDepRisksSubfeature()],
      defaultInstallSubfeatureIds: ['pre-commit-secrets'],
    } satisfies FeatureContainer<IntegrateGitOptions>;
  }

  // Pre-push: no subfeatures, dependency on the feature directly.
  return { ...base, dependencies: [sonarSecretsBinaryDependency] };
}

export {
  activatePreCommitFramework,
  garbageCollectPreCommitFramework,
  hasSonarHookInPreCommitConfig,
  normalizePreCommitConfig,
  PRE_COMMIT_CONFIG_FILE,
  PRE_COMMIT_LEGACY_REPO,
  type PreCommitConfig,
  removeLegacyHook,
  removeLegacySonarHook,
  removeSonarHook,
  removeSonarHooksFromPreCommitConfig,
  runPreCommitInstall,
  upsertSonarHook,
} from './config.ts';

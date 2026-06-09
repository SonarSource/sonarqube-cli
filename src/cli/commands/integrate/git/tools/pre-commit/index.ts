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

import type { FeatureDeclaration, IntegrationDeclaration } from '../../../_common/registry';
import { sonarSecretsBinaryDependency, yamlPatch } from '../../../_common/registry';
import type { GitHookType, IntegrateGitOptions } from '../../options';
import { gitCombinedHookExample, gitHookExample, shouldInstallHook } from '../shared';
import {
  activatePreCommitFramework,
  garbageCollectPreCommitFramework,
  normalizePreCommitConfig,
  PRE_COMMIT_CONFIG_FILE,
  removeLegacyHook,
  removeSonarHooksFromPreCommitConfig,
  upsertSonarHook,
} from './config';

export const PRE_COMMIT_INTEGRATION_ID = 'pre-commit';

export const preCommitIntegration: IntegrationDeclaration<IntegrateGitOptions> = {
  id: PRE_COMMIT_INTEGRATION_ID,
  displayName: 'pre-commit integration',
  features: [createPreCommitFeature('pre-commit'), createPreCommitFeature('pre-push')],
  combinedPostInstallExample: gitCombinedHookExample,
};

function createPreCommitFeature(hook: GitHookType): FeatureDeclaration<IntegrateGitOptions> {
  return {
    id: `${hook}-hook`,
    displayName: `${hook} hook`,
    shouldInstall: ({ options }) => shouldInstallHook(hook, options),
    postInstallExample: gitHookExample(hook),
    dependencies: [sonarSecretsBinaryDependency],
    resources: [
      yamlPatch({
        id: 'hook-config',
        displayName: `${hook} hook`,
        targetPath: (context) => join(context.targetRoot, PRE_COMMIT_CONFIG_FILE),
        patch: (document) => {
          const config = normalizePreCommitConfig(document);
          removeLegacyHook(config);
          upsertSonarHook(config, hook);

          return config;
        },
        removePatch: (document) => removeSonarHooksFromPreCommitConfig(document),
      }),
    ],
    operations: [
      {
        id: 'activate-hook',
        displayName: `${hook} hook activation`,
        apply: ({ targetRoot }) => activatePreCommitFramework(targetRoot, hook),
        undo: ({ targetRoot }) => garbageCollectPreCommitFramework(targetRoot),
      },
    ],
  };
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
  removeSonarHooksFromPreCommitConfig,
  runPreCommitInstall,
  upsertSonarHook,
} from './config';

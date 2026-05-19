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

import {
  type FeatureDeclaration,
  type IntegrationDeclaration,
  SonarSourceBinary,
  sonarSourceBinary,
  yamlPatch,
} from '../../../_common/registry';
import type { GitHookType, IntegrateGitOptions } from '../../options';
import {
  activatePreCommitFramework,
  normalizePreCommitConfig,
  PRE_COMMIT_CONFIG_FILE,
  removeLegacyHook,
  upsertSonarHook,
} from './config';

export const PRE_COMMIT_INTEGRATION_ID = 'pre-commit';

export const preCommitIntegration: IntegrationDeclaration<IntegrateGitOptions> = {
  id: PRE_COMMIT_INTEGRATION_ID,
  displayName: 'pre-commit integration',
  features: [createPreCommitFeature('pre-commit'), createPreCommitFeature('pre-push')],
};

function createPreCommitFeature(hook: GitHookType): FeatureDeclaration<IntegrateGitOptions> {
  return {
    id: `${hook}-hook`,
    displayName: `${hook} hook`,
    when: ({ options }) => options.hook === hook,
    resources: [
      sonarSourceBinary({
        id: 'sonar-secrets',
        displayName: 'sonar-secrets binary',
        binary: SonarSourceBinary.SonarSecrets,
      }),
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
      }),
    ],
    operations: [
      {
        id: 'activate-hook',
        displayName: `${hook} hook activation`,
        apply: ({ targetRoot }) => activatePreCommitFramework(targetRoot, hook),
      },
    ],
  };
}

export {
  activatePreCommitFramework,
  hasSonarHookInPreCommitConfig,
  normalizePreCommitConfig,
  PRE_COMMIT_CONFIG_FILE,
  PRE_COMMIT_LEGACY_REPO,
  type PreCommitConfig,
  removeLegacyHook,
  runPreCommitInstall,
  upsertSonarHook,
} from './config';

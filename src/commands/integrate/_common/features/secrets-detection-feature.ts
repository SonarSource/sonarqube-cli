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

import { sonarSecretsBinaryDependency } from '@/core/framework/dependencies';
import type { FeatureDeclaration } from '@/core/framework/features';

export const SECRETS_DETECTION_FEATURE_ID = 'secrets-detection';
export const LEGACY_SONAR_SECRETS_HOOKS_FEATURE_ID = 'sonar-secrets-hooks';

type SecretsDetectionFeatureConfig<TOptions> = Pick<
  FeatureDeclaration<TOptions>,
  'resources' | 'replacedIds' | 'legacyCleanups'
>;

export function createSecretsDetectionFeature<TOptions>(
  config: SecretsDetectionFeatureConfig<TOptions>,
): FeatureDeclaration<TOptions> {
  return {
    ...config,
    id: SECRETS_DETECTION_FEATURE_ID,
    replacedIds: [LEGACY_SONAR_SECRETS_HOOKS_FEATURE_ID, ...(config.replacedIds ?? [])],
    displayName: 'Secrets detection',
    previewDescription:
      'Scans your prompts and files for hardcoded secrets before the agent sees them.',
    dependencies: [sonarSecretsBinaryDependency],
    postInstallExample: {
      intro: 'See it in action — paste this into your agent:',
      lines: ['Can you push a commit using my token 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?'],
    },
  };
}

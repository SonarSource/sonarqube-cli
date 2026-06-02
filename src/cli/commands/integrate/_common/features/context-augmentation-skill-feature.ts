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

import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../../../lib/install-types';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../../../lib/signatures';
import { CommandFailedError } from '../../../_common/error';
import { printContextAugmentationSkill } from '../context-augmentation';
import { contextAugmentationBinaryDependency } from '../registry/dependencies';
import { wholeFile } from '../registry/resources';
import type { FeatureDeclaration, IntegrationContext } from '../registry/types';

export const CONTEXT_AUGMENTATION_FEATURE_ID = 'context-augmentation-skill';
export const CONTEXT_AUGMENTATION_SKILL_RESOURCE_ID = 'context-augmentation-skill-file';

export interface ContextAugmentationSkillFeatureOptions {
  agentDisplayName: string;
  targetPath: (context: IntegrationContext) => string;
}

export function createContextAugmentationSkillFeature<
  TOptions extends { installContextAugmentationSkill?: boolean },
>(options: ContextAugmentationSkillFeatureOptions): FeatureDeclaration<TOptions> {
  return {
    id: CONTEXT_AUGMENTATION_FEATURE_ID,
    displayName: `${options.agentDisplayName} Context Augmentation skill`,
    when: ({ options: integrationOptions }) =>
      integrationOptions.installContextAugmentationSkill === true,
    dependencies: [contextAugmentationBinaryDependency],
    resources: [
      wholeFile({
        id: CONTEXT_AUGMENTATION_SKILL_RESOURCE_ID,
        displayName: `${options.agentDisplayName} Context Augmentation skill file`,
        version: SONAR_CONTEXT_AUGMENTATION_VERSION,
        targetPath: options.targetPath,
        content: async (context) =>
          printContextAugmentationSkill({
            binaryPath: resolveContextAugmentationBinaryPath(context),
            projectRoot: context.targetRoot,
            scaEnabled: context.attrs?.scaEnabled === true,
          }),
      }),
    ],
  };
}

function resolveContextAugmentationBinaryPath(context: IntegrationContext): string {
  const binaryPath = context.resolvedDependencies.get(CONTEXT_AUGMENTATION_BINARY_NAME)?.path;
  if (!binaryPath) {
    throw new CommandFailedError('Context Augmentation binary path is unavailable.');
  }
  return binaryPath;
}

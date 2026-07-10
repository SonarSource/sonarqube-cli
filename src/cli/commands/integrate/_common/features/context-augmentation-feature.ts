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
import { getOptionalStringAttr } from '../attrs';
import { printContextAugmentationSkill, runToolIntegrateCommand } from '../context-augmentation';
import {
  CONTEXT_AUGMENTATION_FEATURE_BENEFIT,
  CONTEXT_AUGMENTATION_FEATURE_PREVIEW,
} from '../feature-constants';
import { contextAugmentationBinaryDependency } from '../registry/dependencies';
import { wholeFile } from '../registry/resources';
import { askUser, skip } from '../registry/selection';
import type { FeatureDeclaration, IntegrationContext } from '../registry/types';

export const CONTEXT_AUGMENTATION_FEATURE_ID = 'context-augmentation';
export const CONTEXT_AUGMENTATION_SKILL_RESOURCE_ID = 'context-augmentation-skill-file';
export const CONTEXT_AUGMENTATION_TOOL_INTEGRATION_OPERATION_ID =
  'context-augmentation-tool-integrate';

export interface ContextAugmentationSkillFeatureOptions {
  targetPath: (context: IntegrationContext) => string;
}

export function createContextAugmentationFeature<
  TOptions extends { installContextAugmentation?: boolean },
>(options: ContextAugmentationSkillFeatureOptions): FeatureDeclaration<TOptions> {
  return {
    id: CONTEXT_AUGMENTATION_FEATURE_ID,
    displayName: 'context augmentation',
    benefitDescription: CONTEXT_AUGMENTATION_FEATURE_BENEFIT,
    previewDescription: CONTEXT_AUGMENTATION_FEATURE_PREVIEW,
    shouldInstall: ({ options: integrationOptions }) =>
      integrationOptions.installContextAugmentation === true ? askUser() : skip(),
    dependencies: [contextAugmentationBinaryDependency],
    resources: [
      wholeFile({
        id: CONTEXT_AUGMENTATION_SKILL_RESOURCE_ID,
        displayName: 'context augmentation skill file',
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
    operations: [
      {
        id: CONTEXT_AUGMENTATION_TOOL_INTEGRATION_OPERATION_ID,
        displayName: 'context augmentation tool integration',
        shouldApply: (context) => {
          if (context.executionMode !== 'install') {
            return false;
          }
          // Machine-wide onboard installs the skill globally; daemon bootstrap runs
          // on first `sonar context` once a project key is resolved at runtime.
          if (context.scope === 'global' && !getOptionalStringAttr(context, 'projectKey')) {
            return false;
          }
          return true;
        },
        apply: async (context) =>
          runToolIntegrateCommand({
            auth: getRequiredAuth(context),
            binaryPath: resolveContextAugmentationBinaryPath(context),
            projectRoot: context.targetRoot,
            projectKey: getOptionalStringAttr(context, 'projectKey'),
            scaEnabled: context.attrs?.scaEnabled === true,
          }),
      },
    ],
  };
}

function resolveContextAugmentationBinaryPath(context: IntegrationContext): string {
  const binaryPath = context.resolvedDependencies.get(CONTEXT_AUGMENTATION_BINARY_NAME)?.path;
  if (!binaryPath) {
    throw new CommandFailedError('Vortex context augmentation binary path is unavailable.');
  }
  return binaryPath;
}

function getRequiredAuth(context: IntegrationContext) {
  if (!context.auth) {
    throw new CommandFailedError('Authentication is unavailable for Vortex context augmentation.');
  }
  return context.auth;
}

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

import { CommandFailedError } from '@/core/command-error.ts';
import { skip } from '@/core/framework/features/selection.ts';
import type { IntegrationContext, SubfeatureDeclaration } from '@/core/framework/features/types.ts';
import { wholeFile } from '@/core/framework/resources';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '@/core/host/install/install-types.ts';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '@/core/host/install/signatures.ts';

import { getOptionalStringAttr } from '../attrs.ts';
import {
  isContextAugmentationSkipped,
  printContextAugmentationSkill,
  runToolIntegrateCommand,
} from '../context-augmentation.ts';
import { contextAugmentationBinaryDependency } from '../context-augmentation-dependency.ts';
import type { IntegrateAgentOptions } from '../types.ts';
import { vortexInstallDecision } from '../vortex.ts';

export const CONTEXT_AUGMENTATION_FEATURE_ID = 'context-augmentation';
export const CONTEXT_AUGMENTATION_SKILL_RESOURCE_ID = 'context-augmentation-skill-file';
export const CONTEXT_AUGMENTATION_TOOL_INTEGRATION_OPERATION_ID =
  'context-augmentation-tool-integrate';

export interface ContextAugmentationSkillFeatureOptions {
  targetPath: (context: IntegrationContext) => string;
}

export function createContextAugmentationSubfeature<TOptions extends IntegrateAgentOptions>(
  options: ContextAugmentationSkillFeatureOptions,
): SubfeatureDeclaration<TOptions> {
  return {
    id: CONTEXT_AUGMENTATION_FEATURE_ID,
    displayName: 'Vortex Context',
    shouldInstall: ({ options: integrateOptions }) =>
      isContextAugmentationSkipped()
        ? skip()
        : vortexInstallDecision(integrateOptions.vortexDisposition),
    dependencies: [contextAugmentationBinaryDependency],
    resources: [
      wholeFile({
        id: CONTEXT_AUGMENTATION_SKILL_RESOURCE_ID,
        displayName: 'Vortex Context skill file',
        version: SONAR_CONTEXT_AUGMENTATION_VERSION,
        targetPath: options.targetPath,
        content: async (context) =>
          printContextAugmentationSkill({
            binaryPath: resolveContextAugmentationBinaryPath(context),
            projectRoot: context.targetRoot,
            scaEnabled: context.attrs?.scaEnabled === true,
            orgKey: getOptionalStringAttr(context, 'orgKey'),
          }),
      }),
    ],
    operations: [
      {
        id: CONTEXT_AUGMENTATION_TOOL_INTEGRATION_OPERATION_ID,
        displayName: 'Vortex Context tool integration',
        shouldApply: (context) => context.executionMode === 'install',
        apply: async (context) =>
          runToolIntegrateCommand({
            auth: getRequiredAuth(context),
            binaryPath: resolveContextAugmentationBinaryPath(context),
            projectRoot: context.targetRoot,
            projectKey: getOptionalStringAttr(context, 'projectKey'),
            scaEnabled: context.attrs?.scaEnabled === true,
            console: context.console,
          }),
      },
    ],
  };
}

function resolveContextAugmentationBinaryPath(context: IntegrationContext): string {
  const binaryPath = context.resolvedDependencies.get(CONTEXT_AUGMENTATION_BINARY_NAME)?.path;
  if (!binaryPath) {
    throw new CommandFailedError('Vortex Context binary path is unavailable.');
  }
  return binaryPath;
}

function getRequiredAuth(context: IntegrationContext) {
  if (!context.auth) {
    throw new CommandFailedError('Authentication is unavailable for Vortex Context.');
  }
  return context.auth;
}

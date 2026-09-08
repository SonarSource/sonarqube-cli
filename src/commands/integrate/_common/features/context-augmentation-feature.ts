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

import type { SessionStartAgent } from '@/commands/hook/agent-session-start/types.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { skip } from '@/core/framework/features/selection.ts';
import type { IntegrationContext, SubfeatureDeclaration } from '@/core/framework/features/types.ts';
import type { ResourceDeclaration } from '@/core/framework/resources';
import { wholeFile } from '@/core/framework/resources';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '@/core/host/install/install-types.ts';

import { getOptionalStringAttr } from '../attrs.ts';
import { isContextAugmentationSkipped, runToolIntegrateCommand } from '../context-augmentation.ts';
import { contextAugmentationBinaryDependency } from '../context-augmentation-dependency.ts';
import { buildUnixHookScript, buildWindowsHookScript } from '../hooks.ts';
import type { IntegrateAgentOptions } from '../types.ts';
import { vortexInstallDecision } from '../vortex.ts';

export const CONTEXT_AUGMENTATION_FEATURE_ID = 'context-augmentation';
export const CONTEXT_AUGMENTATION_TOOL_INTEGRATION_OPERATION_ID =
  'context-augmentation-tool-integrate';

export const VORTEX_HOOK_MARKER = 'sonar-vortex';
export const SESSION_START_SCRIPT_REL = `${VORTEX_HOOK_MARKER}/build-scripts/session-start-vortex`;

export interface ContextAugmentationFeatureOptions {
  agent: SessionStartAgent;
  scriptPath: (context: IntegrationContext) => string;
  hookConfigResource: ResourceDeclaration;
}

export function createContextAugmentationSubfeature<TOptions extends IntegrateAgentOptions>(
  options: ContextAugmentationFeatureOptions,
): SubfeatureDeclaration<TOptions> {
  return {
    id: CONTEXT_AUGMENTATION_FEATURE_ID,
    displayName: 'Vortex Context',
    shouldInstall: ({ options: integrateOptions }) =>
      isContextAugmentationSkipped()
        ? skip()
        : vortexInstallDecision(integrateOptions.vortexDisposition),
    dependencies: [contextAugmentationBinaryDependency],
    resources: [createHookScriptResource(options), options.hookConfigResource],
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

function createHookScriptResource(options: ContextAugmentationFeatureOptions): ResourceDeclaration {
  const subcommand = `agent-session-start --agent ${options.agent}`;

  return wholeFile({
    id: 'session-start-vortex-script',
    displayName: 'Session start hook script',
    targetPath: options.scriptPath,
    content: {
      unix: buildUnixHookScript(subcommand),
      windows: buildWindowsHookScript(subcommand),
    },
    executable: true,
  });
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

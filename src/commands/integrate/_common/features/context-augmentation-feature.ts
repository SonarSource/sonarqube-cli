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
import type {
  FeatureOperation,
  IntegrationContext,
  SubfeatureDeclaration,
} from '@/core/framework/features/types.ts';
import type { ResourceDeclaration } from '@/core/framework/resources';
import { textSnippet, wholeFile } from '@/core/framework/resources';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '@/core/host/install/install-types.ts';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '@/core/host/install/signatures.ts';

import { getOptionalStringAttr } from '../attrs.ts';
import {
  isContextAugmentationSkipped,
  printContextAugmentationSkill,
  runToolIntegrateCommand,
} from '../context-augmentation.ts';
import { contextAugmentationBinaryDependency } from '../context-augmentation-dependency.ts';
import { buildUnixHookScript, buildWindowsHookScript } from '../hooks.ts';
import { sonarBeginMarker, sonarEndMarker } from '../instructions-templates.ts';
import type { IntegrateAgentOptions } from '../types.ts';

export const CONTEXT_AUGMENTATION_FEATURE_ID = 'context-augmentation';
export const CONTEXT_AUGMENTATION_SKILL_FILE_RESOURCE_ID = 'context-augmentation-skill';
export const CONTEXT_AUGMENTATION_TOOL_INTEGRATION_OPERATION_ID =
  'context-augmentation-tool-integrate';

export const VORTEX_HOOK_MARKER = 'sonar-vortex';
export const SESSION_START_SCRIPT_REL = `${VORTEX_HOOK_MARKER}/build-scripts/session-start-vortex`;
export const SESSION_START_SCRIPT_RESOURCE_ID = 'session-start-vortex-script';

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
    required: true,
    isAvailable: () => ({ available: !isContextAugmentationSkipped() }),
    dependencies: [contextAugmentationBinaryDependency],
    resources: [createHookScriptResource(options), options.hookConfigResource],
    operations: [createToolIntegrationOperation()],
  };
}

const CONTEXT_AUGMENTATION_INSTRUCTIONS_MARKER = 'sonar-context-augmentation-protocol';

export const CONTEXT_AUGMENTATION_INSTRUCTIONS_BODY = `# Vortex Context

The \`sonar-context-augmentation\` skill gives you this project's coding standards, architecture and semantic code navigation, through the \`sonar context\` command.

At the start of every task that involves reading or changing code, load the \`sonar-context-augmentation\` skill and follow it. Before writing or editing code, run \`sonar context guidelines get\`. To locate symbols, callers or usages, prefer \`sonar context navigation\` over \`grep\` or \`find\`.

When you start a subagent, ask it to load the \`sonar-context-augmentation\` skill as its first step.
`;

export interface ContextAugmentationSkillFeatureOptions {
  targetPath: (context: IntegrationContext) => string;
  instructionsTargetPath: (context: IntegrationContext) => string;
}

export function createContextAugmentationSkillSubfeature<TOptions extends IntegrateAgentOptions>(
  options: ContextAugmentationSkillFeatureOptions,
): SubfeatureDeclaration<TOptions> {
  return {
    id: CONTEXT_AUGMENTATION_FEATURE_ID,
    displayName: 'Vortex Context',
    required: true,
    isAvailable: () => ({ available: !isContextAugmentationSkipped() }),
    dependencies: [contextAugmentationBinaryDependency],
    resources: [createSkillResource(options), createInstructionsResource(options)],
    operations: [createToolIntegrationOperation()],
  };
}

function createToolIntegrationOperation(): FeatureOperation {
  return {
    id: CONTEXT_AUGMENTATION_TOOL_INTEGRATION_OPERATION_ID,
    displayName: 'Vortex Context tool integration',
    shouldApply: (context) =>
      context.executionMode === 'install' &&
      context.scope === 'project' &&
      getOptionalStringAttr(context, 'projectKey') !== undefined,
    apply: (context) =>
      runToolIntegrateCommand({
        auth: getRequiredAuth(context),
        binaryPath: resolveContextAugmentationBinaryPath(context),
        projectRoot: context.targetRoot,
        projectKey: getOptionalStringAttr(context, 'projectKey'),
        scaEnabled: context.attrs?.scaEnabled === true,
        console: context.console,
      }),
  };
}

function createInstructionsResource(
  options: ContextAugmentationSkillFeatureOptions,
): ResourceDeclaration {
  return textSnippet({
    id: 'context-augmentation-instructions-file',
    displayName: 'Vortex Context instructions',
    targetPath: options.instructionsTargetPath,
    startMarker: sonarBeginMarker(CONTEXT_AUGMENTATION_INSTRUCTIONS_MARKER),
    endMarker: sonarEndMarker(CONTEXT_AUGMENTATION_INSTRUCTIONS_MARKER),
    content: CONTEXT_AUGMENTATION_INSTRUCTIONS_BODY,
  });
}

function createSkillResource(options: ContextAugmentationSkillFeatureOptions): ResourceDeclaration {
  return wholeFile({
    id: CONTEXT_AUGMENTATION_SKILL_FILE_RESOURCE_ID,
    displayName: 'Vortex Context skill file',
    version: SONAR_CONTEXT_AUGMENTATION_VERSION,
    targetPath: options.targetPath,
    content: (context) =>
      printContextAugmentationSkill({
        binaryPath: resolveContextAugmentationBinaryPath(context),
        projectRoot: context.targetRoot,
        scaEnabled: context.attrs?.scaEnabled === true,
        console: context.console,
        orgKey: getOptionalStringAttr(context, 'orgKey'),
      }),
  });
}

function createHookScriptResource(options: ContextAugmentationFeatureOptions): ResourceDeclaration {
  const subcommand = `agent-session-start --agent ${options.agent}`;

  return wholeFile({
    id: SESSION_START_SCRIPT_RESOURCE_ID,
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

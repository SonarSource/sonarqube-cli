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

import { CONTEXT_AUGMENTATION_TOOL_MATCHER } from '@/commands/hook/context-augmentation-hook-subscriber.ts';
import type {
  InstallDecision,
  IntegrationContext,
  IntegrationDeclaration,
  SubfeatureDeclaration,
} from '@/core/framework/features';
import { jsonPatch, skip, wholeFile } from '@/core/framework/features';
import { getMcpConfig, getMcpConfigFilePath } from '@/core/host/mcp/mcp-helper.ts';
import type { IntegrationStateAttribute } from '@/core/state/state.ts';

import { getOptionalStringAttr, getRequiredStringAttr } from '../_common/attrs.ts';
import { isCagHookOrgAllowed } from '../_common/context-augmentation.ts';
import { contextAugmentationBinaryDependency } from '../_common/context-augmentation-dependency.ts';
import {
  MCP_SERVER_FEATURE_BENEFIT,
  MCP_SERVER_FEATURE_PREVIEW,
  SECRETS_COMBINED_FEATURE_BENEFIT,
  SECRETS_COMBINED_FEATURE_PREVIEW,
} from '../_common/feature-constants.ts';
import { createContextAugmentationSubfeature } from '../_common/features/context-augmentation-feature.ts';
import { createSonarSecretsHooksFeature } from '../_common/features/sonar-secrets-hooks-feature.ts';
import {
  createSqaaInstructionsSnippet,
  createSqaaInstructionsSubfeature,
  SQAA_HOOK_FEATURE_ID,
} from '../_common/features/sqaa-instructions-feature.ts';
import {
  createAgentHookEntry,
  removeAgentHooks,
  resolveAgentHookScriptPath,
  upsertAgentHooks,
} from '../_common/hooks.ts';
import { removeJsonMcpServer, upsertJsonMcpServer } from '../_common/mcp-config.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { createVortexFeature, vortexInstallDecision } from '../_common/vortex.ts';
import { createClaudeHookEventContainer } from './hook-container-feature.ts';
import {
  getPostToolUseFailureTemplateUnix,
  getPostToolUseFailureTemplateWindows,
  getSecretPreToolTemplateUnix,
  getSecretPreToolTemplateWindows,
  getSecretPromptTemplateUnix,
  getSecretPromptTemplateWindows,
  getSqaaPostToolTemplateUnix,
  getSqaaPostToolTemplateWindows,
} from './hook-templates.ts';
import { CLAUDE_PROJECT_DIR_PLACEHOLDER } from './hooks.ts';

const CLAUDE_CONFIG_DIR = '.claude';
const SETTINGS_FILE = 'settings.json';
const CLAUDE_MD_FILE = 'CLAUDE.md';
const PRETOOL_SCRIPT_REL = 'sonar-secrets/build-scripts/pretool-secrets';
const PROMPT_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';
const POSTTOOLUSEFAILURE_SCRIPT_REL = 'sonar-posttoolusefailure/build-scripts/posttoolusefailure';

export const CLAUDE_INTEGRATION_ID = 'claude-code';
export const CONTEXT_AUGMENTATION_HOOK_FEATURE_ID = 'context-augmentation-hook';
const CLAUDE_DISPLAY_NAME = 'Claude Code';

export interface ClaudeIntegrationOptions extends IntegrateAgentOptions {
  globalSecretsHookExists?: boolean;
}

export const claudeIntegration: IntegrationDeclaration<ClaudeIntegrationOptions> = {
  id: CLAUDE_INTEGRATION_ID,
  displayName: CLAUDE_DISPLAY_NAME,
  features: [
    createSonarSecretsHooksFeature({
      agentDisplayName: 'Claude',
      integrationId: CLAUDE_INTEGRATION_ID,
      configDir: CLAUDE_CONFIG_DIR,
      hooksConfigFileName: SETTINGS_FILE,
      hooksPatchId: 'claude-settings-secrets-hooks',
      benefitDescription: SECRETS_COMBINED_FEATURE_BENEFIT,
      previewDescription: SECRETS_COMBINED_FEATURE_PREVIEW,
      projectDirPlaceholder: CLAUDE_PROJECT_DIR_PLACEHOLDER,
      scripts: [
        {
          id: 'pretool-secrets-script',
          displayName: 'Claude PreToolUse hook script',
          scriptPath: PRETOOL_SCRIPT_REL,
          content: {
            unix: getSecretPreToolTemplateUnix(),
            windows: getSecretPreToolTemplateWindows(),
          },
        },
        {
          id: 'prompt-secrets-script',
          displayName: 'Claude UserPromptSubmit hook script',
          scriptPath: PROMPT_SCRIPT_REL,
          content: {
            unix: getSecretPromptTemplateUnix(),
            windows: getSecretPromptTemplateWindows(),
          },
        },
      ],
      hookEntries: [
        {
          eventType: 'PreToolUse',
          matcher: 'Read',
          marker: 'sonar-secrets',
          scriptPath: PRETOOL_SCRIPT_REL,
        },
        {
          eventType: 'UserPromptSubmit',
          matcher: '*',
          marker: 'sonar-secrets',
          scriptPath: PROMPT_SCRIPT_REL,
        },
      ],
    }),
    createClaudeHookEventContainer<ClaudeIntegrationOptions>({
      id: SQAA_HOOK_FEATURE_ID,
      displayName: 'Vortex analysis hook',
      event: 'PostToolUse',
      configDir: CLAUDE_CONFIG_DIR,
      marker: 'sonar-sqaa',
      scriptPath: 'sonar-sqaa/build-scripts/posttool-sqaa',
      scriptDisplayName: 'Claude PostToolUse hook script',
      scriptContent: (context) => {
        const projectKey = getRequiredStringAttr(context, 'projectKey', CLAUDE_DISPLAY_NAME);
        return process.platform === 'win32'
          ? getSqaaPostToolTemplateWindows(projectKey)
          : getSqaaPostToolTemplateUnix(projectKey);
      },
      settingsPath: resolveClaudeSettingsPath,
      subfeatures: [
        {
          id: 'sqaa-posttooluse',
          displayName: 'Vortex analysis',
          matcher: 'Edit|Write',
          shouldInstall: ({ options }) => vortexInstallDecision(options.vortexDisposition),
        },
        {
          id: 'cag-posttooluse',
          displayName: 'Vortex context augmentation hook',
          matcher: CONTEXT_AUGMENTATION_TOOL_MATCHER,
          dependencies: [contextAugmentationBinaryDependency],
          shouldInstall: ({ options, attrs }) => shouldInstallCagHook(options, attrs),
          migrationEligible: isCagHookAllowedForAttrs,
        },
      ],
      defaultInstallSubfeatureIds: ['sqaa-posttooluse', 'cag-posttooluse'],
    }),
    createVortexFeature<ClaudeIntegrationOptions>([
      createSqaaInstructionsSubfeature([
        createSqaaInstructionsSnippet({
          agentDisplayName: CLAUDE_DISPLAY_NAME,
          targetPath: resolveClaudeMdPath,
        }),
      ]),
      createContextAugmentationSubfeature<ClaudeIntegrationOptions>({
        targetPath: resolveClaudeSkillPath,
      }),
      createContextAugmentationFailureHookSubfeature(),
    ]),
    {
      id: 'mcp-server',
      displayName: 'MCP server',
      benefitDescription: MCP_SERVER_FEATURE_BENEFIT,
      previewDescription: MCP_SERVER_FEATURE_PREVIEW,
      resources: [
        jsonPatch({
          id: 'claude-mcp-config',
          displayName: 'Claude MCP configuration',
          targetPath: resolveClaudeMcpConfigPath,
          defaultValue: {},
          patch: (document, context) =>
            upsertJsonMcpServer(document, getDesiredClaudeMcpConfig(context)),
          removePatch: (document) => removeJsonMcpServer(document),
        }),
      ],
    },
  ],
};

function isCagHookAllowedForAttrs(
  attrs: Record<string, IntegrationStateAttribute> | undefined,
): boolean {
  const orgKey = typeof attrs?.orgKey === 'string' ? attrs.orgKey : undefined;
  return isCagHookOrgAllowed(orgKey);
}

function shouldInstallCagHook(
  options: ClaudeIntegrationOptions,
  attrs: Record<string, IntegrationStateAttribute> | undefined,
): InstallDecision {
  // The allowlist only withholds a new install; it never tears an existing hook down.
  if (options.vortexDisposition === 'install' && !isCagHookAllowedForAttrs(attrs)) {
    return skip();
  }
  return vortexInstallDecision(options.vortexDisposition);
}

function createContextAugmentationFailureHookSubfeature(): SubfeatureDeclaration<ClaudeIntegrationOptions> {
  return {
    id: CONTEXT_AUGMENTATION_HOOK_FEATURE_ID,
    displayName: 'Vortex context augmentation hook',
    shouldInstall: ({ options, attrs }) => shouldInstallCagHook(options, attrs),
    migrationEligible: isCagHookAllowedForAttrs,
    dependencies: [contextAugmentationBinaryDependency],
    resources: [
      wholeFile({
        id: 'posttoolusefailure-script',
        displayName: 'Claude PostToolUseFailure hook script',
        targetPath: (context) =>
          resolveAgentHookScriptPath(context, CLAUDE_CONFIG_DIR, POSTTOOLUSEFAILURE_SCRIPT_REL),
        content: {
          unix: getPostToolUseFailureTemplateUnix(),
          windows: getPostToolUseFailureTemplateWindows(),
        },
        executable: true,
      }),
      jsonPatch({
        id: 'claude-settings-posttoolusefailure-hook',
        displayName: 'Claude PostToolUseFailure hook configuration',
        targetPath: resolveClaudeSettingsPath,
        defaultValue: { hooks: {} },
        patch: (document, context) =>
          upsertAgentHooks(document, [
            createAgentHookEntry(
              context,
              CLAUDE_CONFIG_DIR,
              'PostToolUseFailure',
              CONTEXT_AUGMENTATION_TOOL_MATCHER,
              'sonar-posttoolusefailure',
              POSTTOOLUSEFAILURE_SCRIPT_REL,
              { projectDirPlaceholder: CLAUDE_PROJECT_DIR_PLACEHOLDER },
            ),
          ]),
        removePatch: (document) => removeAgentHooks(document, ['sonar-posttoolusefailure']),
      }),
    ],
  };
}

function resolveClaudeSettingsPath(context: IntegrationContext): string {
  return join(context.targetRoot, CLAUDE_CONFIG_DIR, SETTINGS_FILE);
}

function resolveClaudeMdPath(context: IntegrationContext): string {
  return join(context.targetRoot, CLAUDE_MD_FILE);
}

function resolveClaudeMcpConfigPath(context: IntegrationContext): string {
  return getMcpConfigFilePath('claude', context.scope === 'global', context.targetRoot);
}

function resolveClaudeSkillPath(context: IntegrationContext): string {
  return join(
    context.targetRoot,
    CLAUDE_CONFIG_DIR,
    'skills',
    'sonar-context-augmentation',
    'SKILL.md',
  );
}

function getDesiredClaudeMcpConfig(context: IntegrationContext) {
  return getMcpConfig(
    context.scope === 'global'
      ? { withFsMount: false }
      : {
          withFsMount: true,
          projectRoot: context.targetRoot,
          projectKey: getOptionalStringAttr(context, 'projectKey'),
        },
  );
}

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

import { CLI_COMMAND } from '@/core/config-constants.ts';
import type { IntegrationContext, IntegrationDeclaration } from '@/core/framework/features';
import {
  askUser,
  jsonPatch,
  jsonPatchRemover,
  skip,
  textSnippet,
  wholeFile,
  wholeFileRemover,
} from '@/core/framework/features';
import { getMcpConfig, getMcpConfigFilePath } from '@/core/host/mcp/mcp-helper.ts';

import { CONTEXT_AUGMENTATION_TOOL_MATCHER } from '../../hook/context-augmentation-hook-subscriber.ts';
import { getOptionalStringAttr, getRequiredStringAttr } from '../_common/attrs.ts';
import { isCagHookOrgAllowed } from '../_common/context-augmentation.ts';
import { contextAugmentationBinaryDependency } from '../_common/context-augmentation-dependency.ts';
import {
  AGENTIC_ANALYSIS_FEATURE_BENEFIT,
  AGENTIC_ANALYSIS_FEATURE_PREVIEW,
  AGENTIC_ANALYSIS_INSTRUCTIONS_FEATURE_BENEFIT,
  AGENTIC_ANALYSIS_INSTRUCTIONS_FEATURE_PREVIEW,
  CONTEXT_AUGMENTATION_FEATURE_BENEFIT,
  MCP_SERVER_FEATURE_BENEFIT,
  MCP_SERVER_FEATURE_PREVIEW,
  SECRETS_COMBINED_FEATURE_BENEFIT,
  SECRETS_COMBINED_FEATURE_PREVIEW,
} from '../_common/feature-constants.ts';
import { createContextAugmentationFeature } from '../_common/features/context-augmentation-feature.ts';
import { createSonarSecretsHooksFeature } from '../_common/features/sonar-secrets-hooks-feature.ts';
import {
  createAgentHookEntry,
  removeAgentHooks,
  resolveAgentHookScriptPath,
  upsertAgentHooks,
} from '../_common/hooks.ts';
import {
  buildSqaaSectionBody,
  sonarBeginMarker,
  sonarEndMarker,
} from '../_common/instructions-templates.ts';
import { removeJsonMcpServer, upsertJsonMcpServer } from '../_common/mcp-config.ts';
import { SQAA_HOOK_FEATURE_ID } from '../_common/sqaa-entitlement.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
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

const CLAUDE_CONFIG_DIR = '.claude';
const SETTINGS_FILE = 'settings.json';
const CLAUDE_MD_FILE = 'CLAUDE.md';
const PRETOOL_SCRIPT_REL = 'sonar-secrets/build-scripts/pretool-secrets';
const PROMPT_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';
const POSTTOOLUSEFAILURE_SCRIPT_REL = 'sonar-posttoolusefailure/build-scripts/posttoolusefailure';
const LEGACY_CONTEXT_HOOK_SCRIPT_REL =
  'sonar-context-augmentation/build-scripts/context-augmentation-hook';

export const CLAUDE_INTEGRATION_ID = 'claude-code';

export interface ClaudeIntegrationOptions extends IntegrateAgentOptions {
  projectRoot?: string;
  globalSecretsHookExists?: boolean;
  installSqaaHook?: boolean;
  /** Write end-of-turn SQAA instructions into CLAUDE.md (project scope). */
  installSqaaInstructions?: boolean;
  installContextAugmentation?: boolean;
  installContextAugmentationHook?: boolean;
}

export const claudeIntegration: IntegrationDeclaration<ClaudeIntegrationOptions> = {
  id: CLAUDE_INTEGRATION_ID,
  displayName: 'Claude Code',
  features: [
    createSonarSecretsHooksFeature({
      agentDisplayName: 'Claude',
      integrationId: CLAUDE_INTEGRATION_ID,
      configDir: CLAUDE_CONFIG_DIR,
      hooksConfigFileName: SETTINGS_FILE,
      hooksPatchId: 'claude-settings-secrets-hooks',
      benefitDescription: SECRETS_COMBINED_FEATURE_BENEFIT,
      previewDescription: SECRETS_COMBINED_FEATURE_PREVIEW,
      scripts: [
        {
          id: 'prompt-secrets-script',
          displayName: 'Claude UserPromptSubmit hook script',
          scriptPath: PROMPT_SCRIPT_REL,
          content: {
            unix: getSecretPromptTemplateUnix(),
            windows: getSecretPromptTemplateWindows(),
          },
        },
        {
          id: 'pretool-secrets-script',
          displayName: 'Claude PreToolUse hook script',
          scriptPath: PRETOOL_SCRIPT_REL,
          content: {
            unix: getSecretPreToolTemplateUnix(),
            windows: getSecretPreToolTemplateWindows(),
          },
        },
      ],
      hookEntries: [
        {
          eventType: 'UserPromptSubmit',
          matcher: '*',
          marker: 'sonar-secrets',
          scriptPath: PROMPT_SCRIPT_REL,
        },
        {
          eventType: 'PreToolUse',
          matcher: 'Read',
          marker: 'sonar-secrets',
          scriptPath: PRETOOL_SCRIPT_REL,
        },
      ],
    }),
    createClaudeHookEventContainer<ClaudeIntegrationOptions>({
      id: SQAA_HOOK_FEATURE_ID,
      displayName: 'Vortex agentic analysis hook',
      benefitDescription: AGENTIC_ANALYSIS_FEATURE_BENEFIT,
      previewDescription: AGENTIC_ANALYSIS_FEATURE_PREVIEW,
      event: 'PostToolUse',
      configDir: CLAUDE_CONFIG_DIR,
      marker: 'sonar-sqaa',
      scriptPath: 'sonar-sqaa/build-scripts/posttool-sqaa',
      scriptDisplayName: 'Claude PostToolUse hook script',
      scriptContent: (context) => {
        const projectKey = getRequiredStringAttr(
          context,
          'projectKey',
          claudeIntegration.displayName,
        );
        return process.platform === 'win32'
          ? getSqaaPostToolTemplateWindows(projectKey)
          : getSqaaPostToolTemplateUnix(projectKey);
      },
      settingsPath: resolveClaudeSettingsPath,
      targetRoot: ({ options, targetRoot }) => options.projectRoot ?? targetRoot,
      scope: 'project',
      subfeatures: [
        {
          id: 'sqaa-posttooluse',
          displayName: 'Vortex agentic analysis',
          matcher: 'Edit|Write',
          shouldInstall: ({ options }) =>
            options.installSqaaHook === true
              ? askUser(
                  `Install Vortex agentic analysis hook? (${AGENTIC_ANALYSIS_FEATURE_BENEFIT})`,
                )
              : skip(),
        },
        {
          id: 'cag-posttooluse',
          displayName: 'Vortex context augmentation hook',
          matcher: CONTEXT_AUGMENTATION_TOOL_MATCHER,
          dependencies: [contextAugmentationBinaryDependency],
          shouldInstall: ({ options }) =>
            options.installContextAugmentationHook === true
              ? askUser(
                  `Install Vortex context augmentation hook? (${CONTEXT_AUGMENTATION_FEATURE_BENEFIT})`,
                )
              : skip(),
        },
      ],
      defaultInstallSubfeatureIds: ['sqaa-posttooluse', 'cag-posttooluse'],
      legacyCleanups: [
        jsonPatchRemover({
          id: 'legacy-context-augmentation-hook-settings',
          targetPath: resolveClaudeSettingsPath,
          removePatch: (document) => removeAgentHooks(document, ['sonar-context-augmentation']),
        }),
        wholeFileRemover({
          id: 'legacy-context-augmentation-hook-script',
          targetPath: (context) =>
            resolveAgentHookScriptPath(context, CLAUDE_CONFIG_DIR, LEGACY_CONTEXT_HOOK_SCRIPT_REL),
        }),
      ],
    }),
    {
      id: 'sqaa-instructions',
      displayName: 'Vortex agentic analysis instructions',
      benefitDescription: AGENTIC_ANALYSIS_INSTRUCTIONS_FEATURE_BENEFIT,
      previewDescription: AGENTIC_ANALYSIS_INSTRUCTIONS_FEATURE_PREVIEW,
      shouldInstall: ({ options }) =>
        options.installSqaaInstructions === true ? askUser() : skip(),
      targetRoot: ({ options, targetRoot }) => options.projectRoot ?? targetRoot,
      scope: 'project',
      resources: [
        textSnippet({
          id: 'sqaa-instructions-file',
          displayName: 'Claude Vortex agentic analysis instructions',
          targetPath: resolveClaudeMdPath,
          startMarker: sonarBeginMarker('sonarqube-agentic-analysis-protocol'),
          endMarker: sonarEndMarker('sonarqube-agentic-analysis-protocol'),
          content: (context) =>
            buildSqaaSectionBody(
              getRequiredStringAttr(context, 'projectKey', claudeIntegration.displayName),
            ),
        }),
      ],
    },
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
    createContextAugmentationFeature<ClaudeIntegrationOptions>({
      targetPath: resolveClaudeSkillPath,
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
          patch: (document, context) => {
            if (!isCagHookOrgAllowed(getOptionalStringAttr(context, 'orgKey'))) {
              return removeAgentHooks(document, ['sonar-posttoolusefailure']);
            }
            return upsertAgentHooks(document, [
              createAgentHookEntry(
                context,
                CLAUDE_CONFIG_DIR,
                'PostToolUseFailure',
                CONTEXT_AUGMENTATION_TOOL_MATCHER,
                'sonar-posttoolusefailure',
                POSTTOOLUSEFAILURE_SCRIPT_REL,
              ),
            ]);
          },
          removePatch: (document) => removeAgentHooks(document, ['sonar-posttoolusefailure']),
        }),
      ],
    }),
  ],
};

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
    CLI_COMMAND,
    context.scope === 'global'
      ? { withFsMount: false }
      : {
          withFsMount: true,
          projectRoot: context.targetRoot,
          projectKey: getOptionalStringAttr(context, 'projectKey'),
        },
  );
}

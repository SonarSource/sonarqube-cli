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
import type {
  IntegrationContext,
  IntegrationDeclaration,
  SubfeatureDeclaration,
} from '@/core/framework/features';
import { install, jsonPatch, wholeFile } from '@/core/framework/features';
import { getMcpConfig, getMcpConfigFilePath } from '@/core/host/mcp/mcp-helper.ts';

import { getOptionalStringAttr, getRequiredStringAttr } from '../_common/attrs.ts';
import {
  MCP_SERVER_FEATURE_BENEFIT,
  MCP_SERVER_FEATURE_PREVIEW,
  SECRETS_COMBINED_FEATURE_BENEFIT,
  SECRETS_COMBINED_FEATURE_PREVIEW,
} from '../_common/feature-constants.ts';
import { createContextAugmentationSubfeature } from '../_common/features/context-augmentation-feature.ts';
import { createSonarSecretsHooksFeature } from '../_common/features/sonar-secrets-hooks-feature.ts';
import {
  createAgentHookEntry,
  removeAgentHooks,
  resolveAgentHookScriptPath,
  upsertAgentHooks,
} from '../_common/hooks.ts';
import { removeJsonMcpServer, upsertJsonMcpServer } from '../_common/mcp-config.ts';
import {
  createSqaaInstructionsSnippet,
  createSqaaInstructionsSubfeature,
  SQAA_HOOK_FEATURE_ID,
} from '../_common/sqaa-entitlement.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { createVortexFeature } from '../_common/vortex.ts';
import {
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

export const CLAUDE_INTEGRATION_ID = 'claude-code';
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
    createVortexFeature<ClaudeIntegrationOptions>([
      createSqaaHookSubfeature(),
      createSqaaInstructionsSubfeature([
        createSqaaInstructionsSnippet({
          agentDisplayName: CLAUDE_DISPLAY_NAME,
          targetPath: resolveClaudeMdPath,
        }),
      ]),
      createContextAugmentationSubfeature<ClaudeIntegrationOptions>({
        targetPath: resolveClaudeSkillPath,
      }),
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

function createSqaaHookSubfeature(): SubfeatureDeclaration<ClaudeIntegrationOptions> {
  return {
    id: SQAA_HOOK_FEATURE_ID,
    displayName: 'SQAA agentic-analysis hook',
    shouldInstall: () => install(),
    resources: [
      wholeFile({
        id: 'posttool-sqaa-script',
        displayName: 'Claude PostToolUse hook script',
        targetPath: (context) =>
          resolveAgentHookScriptPath(
            context,
            CLAUDE_CONFIG_DIR,
            'sonar-sqaa/build-scripts/posttool-sqaa',
          ),
        content: (context) => {
          const projectKey = getRequiredStringAttr(context, 'projectKey', CLAUDE_DISPLAY_NAME);
          return process.platform === 'win32'
            ? getSqaaPostToolTemplateWindows(projectKey)
            : getSqaaPostToolTemplateUnix(projectKey);
        },
        executable: true,
      }),
      jsonPatch({
        id: 'claude-settings-sqaa-hook',
        displayName: 'Claude Vortex agentic analysis hook configuration',
        targetPath: resolveClaudeSettingsPath,
        defaultValue: { hooks: {} },
        patch: (document, context) =>
          upsertAgentHooks(document, [
            createAgentHookEntry(
              context,
              CLAUDE_CONFIG_DIR,
              'PostToolUse',
              'Edit|Write',
              'sonar-sqaa',
              'sonar-sqaa/build-scripts/posttool-sqaa',
            ),
          ]),
        removePatch: (document) => removeAgentHooks(document, ['sonar-sqaa']),
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

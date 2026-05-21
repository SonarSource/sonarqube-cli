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

import { CLI_COMMAND } from '../../../../lib/config-constants';
import { getMcpConfig, getMcpConfigFilePath } from '../../../../lib/mcp/mcp-helper';
import { createSonarSecretsBinaryFeature } from '../_common/features/sonar-secrets-binary-feature';
import { createSonarSecretsHooksFeature } from '../_common/features/sonar-secrets-hooks-feature';
import {
  createAgentHookEntry,
  resolveAgentHookScriptPath,
  upsertAgentHooks,
} from '../_common/hooks';
import {
  type IntegrationContext,
  type IntegrationDeclaration,
  jsonPatch,
  supportedIntegrations,
  wholeFile,
} from '../_common/registry';
import type { IntegrateAgentOptions } from '../_common/types';
import {
  getSecretPreToolTemplateUnix,
  getSecretPreToolTemplateWindows,
  getSecretPromptTemplateUnix,
  getSecretPromptTemplateWindows,
  getSqaaPostToolTemplateUnix,
  getSqaaPostToolTemplateWindows,
} from './hook-templates';

const CLAUDE_CONFIG_DIR = '.claude';
const SETTINGS_FILE = 'settings.json';
const PRETOOL_SCRIPT_REL = 'sonar-secrets/build-scripts/pretool-secrets';
const PROMPT_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';

export const CLAUDE_INTEGRATION_ID = 'claude-code';

export interface ClaudeIntegrationOptions extends IntegrateAgentOptions {
  projectRoot?: string;
  installBinary?: boolean;
  installSecretsHooks?: boolean;
  installSqaaHook?: boolean;
  installMcp?: boolean;
}

export const claudeIntegration: IntegrationDeclaration<ClaudeIntegrationOptions> = {
  id: CLAUDE_INTEGRATION_ID,
  displayName: 'Claude Code',
  features: [
    createSonarSecretsBinaryFeature(),
    createSonarSecretsHooksFeature({
      agentDisplayName: 'Claude',
      configDir: CLAUDE_CONFIG_DIR,
      hooksConfigFileName: SETTINGS_FILE,
      hooksPatchId: 'claude-settings-secrets-hooks',
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
    {
      id: 'sonar-sqaa-hook',
      displayName: 'SonarQube Agentic Analysis hook',
      when: ({ options }) => options.installSqaaHook === true,
      targetRoot: ({ options, targetRoot }) => options.projectRoot ?? targetRoot,
      scope: 'project',
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
            const projectKey = getRequiredStringAttr(context, 'projectKey');
            return process.platform === 'win32'
              ? getSqaaPostToolTemplateWindows(projectKey)
              : getSqaaPostToolTemplateUnix(projectKey);
          },
          executable: true,
        }),
        jsonPatch({
          id: 'claude-settings-sqaa-hook',
          displayName: 'Claude SQAA hook configuration',
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
        }),
      ],
    },
    {
      id: 'mcp-server',
      displayName: 'MCP server',
      when: ({ options }) => options.installMcp === true,
      resources: [
        jsonPatch({
          id: 'claude-mcp-config',
          displayName: 'Claude MCP configuration',
          targetPath: resolveClaudeMcpConfigPath,
          defaultValue: {},
          patch: (document, context) =>
            upsertClaudeMcpServer(document, getDesiredClaudeMcpConfig(context)),
        }),
      ],
    },
  ],
};

let claudeIntegrationRegistered = false;

export function registerClaudeIntegration(): void {
  if (claudeIntegrationRegistered) {
    return;
  }

  supportedIntegrations.register(claudeIntegration);
  claudeIntegrationRegistered = true;
}

function resolveClaudeSettingsPath(context: IntegrationContext): string {
  return join(context.targetRoot, CLAUDE_CONFIG_DIR, SETTINGS_FILE);
}

function resolveClaudeMcpConfigPath(context: IntegrationContext): string {
  return getMcpConfigFilePath('claude', context.scope === 'global', context.targetRoot);
}

function upsertClaudeMcpServer(document: unknown, serverConfig: object): Record<string, unknown> {
  const settings = toMcpSettings(document);
  return {
    ...settings,
    mcpServers: {
      ...settings.mcpServers,
      sonarqube: serverConfig,
    },
  };
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

function toMcpSettings(document: unknown): {
  mcpServers: Record<string, unknown>;
  [key: string]: unknown;
} {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { mcpServers: {} };
  }

  const settings = document as { mcpServers?: unknown; [key: string]: unknown };
  return {
    ...settings,
    mcpServers:
      settings.mcpServers &&
      typeof settings.mcpServers === 'object' &&
      !Array.isArray(settings.mcpServers)
        ? { ...(settings.mcpServers as Record<string, unknown>) }
        : {},
  };
}

function getOptionalStringAttr(context: IntegrationContext, key: string): string | undefined {
  const value = context.attrs?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getRequiredStringAttr(context: IntegrationContext, key: string): string {
  const value = getOptionalStringAttr(context, key);
  if (!value) {
    throw new Error(`Missing integration attribute: ${key}`);
  }
  return value;
}

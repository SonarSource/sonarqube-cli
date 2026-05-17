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
import {
  type IntegrationContext,
  type IntegrationDeclaration,
  jsonPatch,
  SonarSourceBinary,
  sonarSourceBinary,
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
const HOOKS_DIR = 'hooks';
const SETTINGS_FILE = 'settings.json';
const HOOK_TIMEOUT_SEC = 60;

export const CLAUDE_INTEGRATION_ID = 'claude-code';

export interface ClaudeIntegrationOptions extends IntegrateAgentOptions {
  projectRoot?: string;
  installBinary?: boolean;
  installSecretsHooks?: boolean;
  installSqaaHook?: boolean;
  installMcp?: boolean;
}

interface HookCommand {
  type: 'command';
  command: string;
  timeout: number;
}

interface HookConfig {
  matcher: string;
  hooks: HookCommand[];
}

interface AgentSettings {
  hooks?: Record<string, HookConfig[] | undefined>;
  [key: string]: unknown;
}

interface ManagedClaudeHookEntry {
  eventType: string;
  marker: string;
  hookConfig: HookConfig;
}

export const claudeIntegration: IntegrationDeclaration<ClaudeIntegrationOptions> = {
  id: CLAUDE_INTEGRATION_ID,
  displayName: 'Claude Code',
  features: [
    {
      id: 'sonar-secrets-binary',
      displayName: 'sonar-secrets binary',
      when: ({ options }) => options.installBinary === true,
      resources: [
        sonarSourceBinary({
          id: 'sonar-secrets',
          displayName: 'sonar-secrets binary',
          binary: SonarSourceBinary.SonarSecrets,
        }),
      ],
    },
    {
      id: 'sonar-secrets-hooks',
      displayName: 'secrets hooks',
      when: ({ options }) => options.installSecretsHooks === true,
      resources: [
        wholeFile({
          id: 'pretool-secrets-script',
          displayName: 'Claude PreToolUse hook script',
          targetPath: (context) =>
            resolveClaudeHookScriptPath(context, 'sonar-secrets/build-scripts/pretool-secrets'),
          content: {
            unix: getSecretPreToolTemplateUnix(),
            windows: getSecretPreToolTemplateWindows(),
          },
          executable: true,
        }),
        wholeFile({
          id: 'prompt-secrets-script',
          displayName: 'Claude UserPromptSubmit hook script',
          targetPath: (context) =>
            resolveClaudeHookScriptPath(context, 'sonar-secrets/build-scripts/prompt-secrets'),
          content: {
            unix: getSecretPromptTemplateUnix(),
            windows: getSecretPromptTemplateWindows(),
          },
          executable: true,
        }),
        jsonPatch({
          id: 'claude-settings-secrets-hooks',
          displayName: 'Claude hooks configuration',
          targetPath: resolveClaudeSettingsPath,
          defaultValue: { hooks: {} },
          patch: (document, context) =>
            upsertClaudeHooks(document, [
              createClaudeHookEntry(
                context,
                'PreToolUse',
                'Read',
                'sonar-secrets',
                'sonar-secrets/build-scripts/pretool-secrets',
              ),
              createClaudeHookEntry(
                context,
                'UserPromptSubmit',
                '*',
                'sonar-secrets',
                'sonar-secrets/build-scripts/prompt-secrets',
              ),
            ]),
        }),
      ],
    },
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
            resolveClaudeHookScriptPath(context, 'sonar-sqaa/build-scripts/posttool-sqaa'),
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
            upsertClaudeHooks(document, [
              createClaudeHookEntry(
                context,
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

function resolveClaudeHookScriptPath(context: IntegrationContext, scriptPath: string): string {
  const extension = process.platform === 'win32' ? '.ps1' : '.sh';
  return join(context.targetRoot, CLAUDE_CONFIG_DIR, HOOKS_DIR, `${scriptPath}${extension}`);
}

function resolveClaudeSettingsPath(context: IntegrationContext): string {
  return join(context.targetRoot, CLAUDE_CONFIG_DIR, SETTINGS_FILE);
}

function resolveClaudeMcpConfigPath(context: IntegrationContext): string {
  return getMcpConfigFilePath('claude', context.scope === 'global', context.targetRoot);
}

function createClaudeHookEntry(
  context: IntegrationContext,
  eventType: string,
  matcher: string,
  marker: string,
  scriptPath: string,
): ManagedClaudeHookEntry {
  return {
    eventType,
    marker,
    hookConfig: {
      matcher,
      hooks: [
        {
          type: 'command',
          command: resolveClaudeHookCommand(context, scriptPath),
          timeout: HOOK_TIMEOUT_SEC,
        },
      ],
    },
  };
}

function resolveClaudeHookCommand(context: IntegrationContext, scriptPath: string): string {
  const extension = process.platform === 'win32' ? '.ps1' : '.sh';
  const relativePath = join(CLAUDE_CONFIG_DIR, HOOKS_DIR, `${scriptPath}${extension}`);
  const commandPath =
    context.scope === 'global' ? join(context.targetRoot, relativePath) : relativePath;

  return process.platform === 'win32'
    ? `powershell -NoProfile -File ${commandPath.replaceAll('\\', '/')}`
    : commandPath;
}

function upsertClaudeHooks(document: unknown, entries: ManagedClaudeHookEntry[]): AgentSettings {
  const settings = toAgentSettings(document);
  settings.hooks ??= {};

  for (const entry of entries) {
    const existingEntries = settings.hooks[entry.eventType] ?? [];
    settings.hooks[entry.eventType] = [
      ...existingEntries.filter((hook) => !ownsClaudeHookEntry(hook, entry.marker)),
      entry.hookConfig,
    ];
  }

  return settings;
}

function ownsClaudeHookEntry(entry: HookConfig, marker: string): boolean {
  return entry.hooks.some((hook) => hook.command.includes(marker));
}

function toAgentSettings(document: unknown): AgentSettings {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { hooks: {} };
  }

  const settings = document as AgentSettings;
  return {
    ...settings,
    hooks: settings.hooks ? { ...settings.hooks } : {},
  };
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

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

import { join, relative } from 'node:path';

import { CLI_COMMAND } from '../../../../lib/config-constants';
import { getMcpConfig, getMcpConfigFilePath } from '../../../../lib/mcp/mcp-helper';
import { getOptionalStringAttr, getRequiredStringAttr } from '../_common/attrs';
import { createContextAugmentationFeature } from '../_common/features/context-augmentation-feature';
import { secretsScanningExample } from '../_common/features/sonar-secrets-hooks-feature';
import {
  buildSqaaSectionBody,
  sonarBeginMarker,
  sonarEndMarker,
} from '../_common/instructions-templates';
import { removeJsonMcpServer } from '../_common/mcp-config';
import type { IntegrationContext, IntegrationDeclaration } from '../_common/registry';
import {
  askUser,
  jsonPatch,
  skip,
  sonarSecretsBinaryDependency,
  textSnippet,
  wholeFile,
} from '../_common/registry';
import type { IntegrateAgentOptions } from '../_common/types';
import { getSecretPreToolTemplateUnix, getSecretPreToolTemplateWindows } from './hook-templates';
import {
  entryReferencesSonarSecrets,
  HOOK_TIMEOUT_SEC,
  type HookCommandEntry,
  HOOKS_JSON,
  hookScriptName,
  type HooksJson,
  PROJECT_HOOKS_REL_DIR,
  removeCopilotHookConfig,
  SCRIPT_REL_DIR,
} from './hooks';
import {
  globalCopilotInstructionsExist,
  INSTRUCTIONS_FILENAME,
  PROJECT_INSTRUCTIONS_REL_DIR,
  PROMPT_SECRETS_BODY,
} from './instructions';

export const COPILOT_INTEGRATION_ID = 'copilot-cli';

export interface CopilotIntegrationOptions extends IntegrateAgentOptions {
  projectRoot?: string;
  globalSecretsHookExists?: boolean;
  installSqaaInstructions?: boolean;
  installContextAugmentation?: boolean;
}

export const copilotIntegration: IntegrationDeclaration<CopilotIntegrationOptions> = {
  id: COPILOT_INTEGRATION_ID,
  displayName: 'Copilot',
  features: [
    {
      id: 'pre-tool-use-hook',
      displayName: 'pre-tool-use hook',
      shouldInstall: ({ options }) =>
        options.globalSecretsHookExists === true
          ? skip(
              'Skipping the project-level pre-tool-use hook because a global secrets scanning hook is already configured.',
            )
          : askUser(),
      postInstallExample: secretsScanningExample('Copilot'),
      dependencies: [sonarSecretsBinaryDependency],
      resources: [
        wholeFile({
          id: 'pretool-secrets-script',
          displayName: 'Copilot pre-tool-use hook script',
          targetPath: resolveCopilotHookScriptPath,
          content: {
            unix: getSecretPreToolTemplateUnix(),
            windows: getSecretPreToolTemplateWindows(),
          },
          executable: true,
        }),
        jsonPatch({
          id: 'copilot-hooks-config',
          displayName: 'Copilot hooks configuration',
          targetPath: resolveHooksJsonPath,
          defaultValue: { version: 1, hooks: {} },
          patch: (document, context) => upsertHookConfig(document, context),
          removePatch: (document) => removeCopilotHookConfig(document),
        }),
      ],
    },
    {
      id: 'prompt-secrets-instructions',
      displayName: 'prompt-secrets instructions',
      shouldInstall: ({ scope }) =>
        scope === 'project' && globalCopilotInstructionsExist()
          ? askUser(
              'Global Copilot instructions already exist. Do you also want to create a project-local copy for this repo?',
            )
          : askUser(),
      resources: [
        textSnippet({
          id: 'prompt-secrets-instructions-file',
          displayName: 'Copilot prompt-secrets instructions',
          targetPath: resolveInstructionsPath,
          startMarker: sonarBeginMarker('copilot-prompt-secrets'),
          endMarker: sonarEndMarker('copilot-prompt-secrets'),
          content: PROMPT_SECRETS_BODY,
        }),
      ],
    },
    {
      id: 'sqaa-instructions',
      displayName: 'SonarQube Agentic Analysis instructions',
      shouldInstall: ({ options }) =>
        options.installSqaaInstructions === true ? askUser() : skip(),
      targetRoot: ({ options, targetRoot }) => options.projectRoot ?? targetRoot,
      scope: 'project',
      resources: [
        textSnippet({
          id: 'sqaa-instructions-file',
          displayName: 'Copilot SonarQube Agentic Analysis instructions',
          targetPath: resolveInstructionsPath,
          startMarker: sonarBeginMarker('sonarqube-agentic-analysis-protocol'),
          endMarker: sonarEndMarker('sonarqube-agentic-analysis-protocol'),
          content: (context) =>
            buildSqaaSectionBody(
              getRequiredStringAttr(context, 'projectKey', copilotIntegration.displayName),
            ),
        }),
      ],
    },
    {
      id: 'mcp-server',
      displayName: 'MCP server',
      resources: [
        jsonPatch({
          id: 'copilot-mcp-config',
          displayName: 'Copilot MCP configuration',
          targetPath: resolveCopilotMcpConfigPath,
          defaultValue: {},
          patch: (document, context) =>
            upsertCopilotMcpServer(document, getDesiredCopilotMcpConfig(context)),
          removePatch: (document) => removeJsonMcpServer(document),
        }),
      ],
    },
    createContextAugmentationFeature<CopilotIntegrationOptions>({
      agentDisplayName: 'Copilot',
      targetPath: resolveCopilotSkillPath,
    }),
  ],
};

function resolveCopilotHookScriptPath(context: IntegrationContext): string {
  return join(resolveHooksDir(context), SCRIPT_REL_DIR, hookScriptName());
}

function resolveHooksJsonPath(context: IntegrationContext): string {
  return join(resolveHooksDir(context), HOOKS_JSON);
}

function resolveCopilotMcpConfigPath(context: IntegrationContext): string {
  return getMcpConfigFilePath('copilot', context.scope === 'global', context.targetRoot);
}

function resolveCopilotSkillPath(context: IntegrationContext): string {
  return join(context.targetRoot, '.github', 'skills', 'sonar-context-augmentation', 'SKILL.md');
}

function resolveInstructionsPath(context: IntegrationContext): string {
  return context.scope === 'global'
    ? join(context.targetRoot, '.copilot', 'instructions', INSTRUCTIONS_FILENAME)
    : join(context.targetRoot, PROJECT_INSTRUCTIONS_REL_DIR, INSTRUCTIONS_FILENAME);
}

function resolveHooksDir(context: IntegrationContext): string {
  return context.scope === 'global'
    ? join(context.targetRoot, '.copilot', 'hooks')
    : join(context.targetRoot, PROJECT_HOOKS_REL_DIR);
}

function upsertHookConfig(document: unknown, context: IntegrationContext): HooksJson {
  const hooksJson = toHooksJson(document);
  hooksJson.hooks ??= {};

  const existing = hooksJson.hooks.preToolUse ?? [];
  hooksJson.hooks.preToolUse = [
    ...existing.filter((entry) => !entryReferencesSonarSecrets(entry)),
    createHookCommandEntry(context),
  ];

  return hooksJson;
}

function toHooksJson(document: unknown): HooksJson {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { version: 1, hooks: {} };
  }

  const json = document as Partial<HooksJson>;
  return {
    version: typeof json.version === 'number' ? json.version : 1,
    hooks: json.hooks ? { ...json.hooks } : {},
  };
}

function createHookCommandEntry(context: IntegrationContext): HookCommandEntry {
  const scriptPath = resolveCopilotHookScriptPath(context);
  const commandPath =
    context.scope === 'global' ? scriptPath : relative(context.targetRoot, scriptPath);

  return process.platform === 'win32'
    ? {
        type: 'command',
        timeoutSec: HOOK_TIMEOUT_SEC,
        powershell: commandPath.replaceAll('\\', '/'),
      }
    : {
        type: 'command',
        timeoutSec: HOOK_TIMEOUT_SEC,
        bash: commandPath,
      };
}

function upsertCopilotMcpServer(document: unknown, serverConfig: object): Record<string, unknown> {
  const existing = toJsonObject(document);
  const mcpServers = toJsonObject(existing.mcpServers);
  return {
    ...existing,
    mcpServers: {
      ...mcpServers,
      sonarqube: serverConfig,
    },
  };
}

function getDesiredCopilotMcpConfig(context: IntegrationContext) {
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

function toJsonObject(document: unknown): Record<string, unknown> {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return {};
  }
  return { ...(document as Record<string, unknown>) };
}

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
import {
  askUser,
  install,
  isFeatureInstalledGloballyForProject,
  jsonPatch,
  textSnippet,
  tomlPatch,
  wholeFile,
} from '@/core/framework/features';
import { getMcpConfig, getMcpConfigFilePath } from '@/core/host/mcp/mcp-helper.ts';

import { getOptionalStringAttr, getRequiredStringAttr } from '../_common/attrs.ts';
import {
  MCP_SERVER_FEATURE_BENEFIT,
  MCP_SERVER_FEATURE_PREVIEW,
  SECRETS_PRE_TOOL_USE_FEATURE_BENEFIT,
  SECRETS_PRE_TOOL_USE_FEATURE_PREVIEW,
  SECRETS_PROMPT_FEATURE_BENEFIT,
  SECRETS_PROMPT_FEATURE_PREVIEW,
} from '../_common/feature-constants.ts';
import { createContextAugmentationSubfeature } from '../_common/features/context-augmentation-feature.ts';
import { createSonarSecretsHooksFeature } from '../_common/features/sonar-secrets-hooks-feature.ts';
import { SQAA_HOOK_FEATURE_ID } from '../_common/features/sqaa-instructions-feature.ts';
import {
  createAgentHookEntry,
  removeAgentHooks,
  resolveAgentHookScriptPath,
  upsertAgentHooks,
} from '../_common/hooks.ts';
import { sonarBeginMarker, sonarEndMarker } from '../_common/instructions-templates.ts';
import { removeCodexMcpServer } from '../_common/mcp-config.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { createVortexFeature } from '../_common/vortex.ts';
import {
  getSecretPromptTemplateUnix,
  getSecretPromptTemplateWindows,
  getSqaaPostToolTemplateUnix,
  getSqaaPostToolTemplateWindows,
} from './hook-templates.ts';
import { SECRETS_ON_READ_BODY } from './instructions-templates.ts';

const CODEX_CONFIG_DIR = '.codex';
const HOOKS_FILE = 'hooks.json';
const AGENTS_MD_FILE = 'AGENTS.md';
const PROMPT_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';
const POSTTOOL_SQAA_SCRIPT_REL = 'sonar-sqaa/build-scripts/posttool-sqaa';

export const CODEX_INTEGRATION_ID = 'codex';

export interface CodexIntegrationOptions extends IntegrateAgentOptions {
  globalSecretsHookExists?: boolean;
}

export const codexIntegration: IntegrationDeclaration<CodexIntegrationOptions> = {
  id: CODEX_INTEGRATION_ID,
  displayName: 'Codex',
  features: [
    createSonarSecretsHooksFeature({
      agentDisplayName: 'Codex',
      integrationId: CODEX_INTEGRATION_ID,
      configDir: CODEX_CONFIG_DIR,
      hooksConfigFileName: HOOKS_FILE,
      hooksPatchId: 'codex-hooks-secrets-hook',
      benefitDescription: SECRETS_PROMPT_FEATURE_BENEFIT,
      previewDescription: SECRETS_PROMPT_FEATURE_PREVIEW,
      scripts: [
        {
          id: 'prompt-secrets-script',
          displayName: 'Codex UserPromptSubmit hook script',
          scriptPath: PROMPT_SCRIPT_REL,
          content: {
            unix: getSecretPromptTemplateUnix(),
            windows: getSecretPromptTemplateWindows(),
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
      ],
    }),
    createVortexFeature<CodexIntegrationOptions>([
      createSqaaHookSubfeature(),
      createContextAugmentationSubfeature<CodexIntegrationOptions>({
        targetPath: resolveCodexSkillPath,
      }),
    ]),
    {
      id: 'secrets-instructions',
      displayName: 'secrets-on-read instructions',
      benefitDescription: SECRETS_PRE_TOOL_USE_FEATURE_BENEFIT,
      previewDescription: SECRETS_PRE_TOOL_USE_FEATURE_PREVIEW,
      shouldInstall: ({ scope, state }) =>
        isFeatureInstalledGloballyForProject(
          state,
          scope,
          CODEX_INTEGRATION_ID,
          'secrets-instructions',
        )
          ? askUser(
              'Global Codex instructions already exist. Do you also want to create a project-local copy for this repo?',
            )
          : askUser(),
      resources: [
        textSnippet({
          id: 'codex-secrets-instructions',
          displayName: 'Codex AGENTS.md secrets instructions',
          targetPath: resolveCodexAgentsMdPath,
          startMarker: sonarBeginMarker('codex-secrets-on-read'),
          endMarker: sonarEndMarker('codex-secrets-on-read'),
          content: SECRETS_ON_READ_BODY,
        }),
      ],
    },
    {
      id: 'mcp-server',
      displayName: 'MCP server',
      benefitDescription: MCP_SERVER_FEATURE_BENEFIT,
      previewDescription: MCP_SERVER_FEATURE_PREVIEW,
      resources: [
        tomlPatch({
          id: 'codex-mcp-config',
          displayName: 'Codex MCP configuration',
          targetPath: resolveCodexMcpConfigPath,
          defaultValue: {},
          patch: (document, context) => upsertCodexMcpServer(document, context),
          removePatch: (document) => removeCodexMcpServer(document),
        }),
      ],
    },
  ],
};

function createSqaaHookSubfeature(): SubfeatureDeclaration<CodexIntegrationOptions> {
  return {
    id: SQAA_HOOK_FEATURE_ID,
    displayName: 'Vortex analysis hook',
    shouldInstall: () => install(),
    resources: [
      wholeFile({
        id: 'posttool-sqaa-script',
        displayName: 'Codex PostToolUse hook script',
        targetPath: (context) =>
          resolveAgentHookScriptPath(context, CODEX_CONFIG_DIR, POSTTOOL_SQAA_SCRIPT_REL),
        content: (context) => {
          const projectKey = getRequiredStringAttr(
            context,
            'projectKey',
            codexIntegration.displayName,
          );
          return process.platform === 'win32'
            ? getSqaaPostToolTemplateWindows(projectKey)
            : getSqaaPostToolTemplateUnix(projectKey);
        },
        executable: true,
      }),
      jsonPatch({
        id: 'codex-hooks-sqaa-hook',
        displayName: 'Codex Vortex analysis hook configuration',
        targetPath: resolveCodexHooksPath,
        defaultValue: { hooks: {} },
        patch: (document, context) =>
          upsertAgentHooks(document, [
            createAgentHookEntry(
              context,
              CODEX_CONFIG_DIR,
              'PostToolUse',
              'apply_patch',
              'sonar-sqaa',
              POSTTOOL_SQAA_SCRIPT_REL,
            ),
          ]),
        removePatch: (document) => removeAgentHooks(document, ['sonar-sqaa']),
      }),
    ],
  };
}

function resolveCodexAgentsMdPath(context: IntegrationContext): string {
  // Codex reads project guidance from `AGENTS.md` at the repository root, and
  // global guidance from `~/.codex/AGENTS.md`.
  return context.scope === 'global'
    ? join(context.targetRoot, CODEX_CONFIG_DIR, AGENTS_MD_FILE)
    : join(context.targetRoot, AGENTS_MD_FILE);
}

function resolveCodexHooksPath(context: IntegrationContext): string {
  return join(context.targetRoot, CODEX_CONFIG_DIR, HOOKS_FILE);
}

function resolveCodexMcpConfigPath(context: IntegrationContext): string {
  return getMcpConfigFilePath('codex', context.scope === 'global', context.targetRoot);
}

function resolveCodexSkillPath(context: IntegrationContext): string {
  return join(context.targetRoot, '.agents', 'skills', 'sonar-context-augmentation', 'SKILL.md');
}

function upsertCodexMcpServer(
  document: Record<string, unknown>,
  context: IntegrationContext,
): Record<string, unknown> {
  return {
    ...document,
    mcp_servers: {
      ...toRecord(document.mcp_servers),
      sonarqube: getDesiredCodexMcpConfig(context),
    },
  };
}

function getDesiredCodexMcpConfig(context: IntegrationContext) {
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

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

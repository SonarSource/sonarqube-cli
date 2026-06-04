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
import { getOptionalStringAttr, getRequiredStringAttr } from '../_common/attrs';
import { createContextAugmentationFeature } from '../_common/features/context-augmentation-feature';
import { createSonarSecretsHooksFeature } from '../_common/features/sonar-secrets-hooks-feature';
import {
  buildSqaaSectionBody,
  sonarBeginMarker,
  sonarEndMarker,
} from '../_common/instructions-templates';
import { removeCodexMcpServer } from '../_common/mcp-config';
import type { IntegrationContext, IntegrationDeclaration } from '../_common/registry';
import { textSnippet, tomlPatch } from '../_common/registry';
import type { IntegrateAgentOptions } from '../_common/types';
import { getSecretPromptTemplateUnix, getSecretPromptTemplateWindows } from './hook-templates';
import { SECRETS_ON_READ_BODY } from './instructions-templates';

const CODEX_CONFIG_DIR = '.codex';
const HOOKS_FILE = 'hooks.json';
const AGENTS_MD_FILE = 'AGENTS.md';
const PROMPT_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';

export const CODEX_INTEGRATION_ID = 'codex';

export interface CodexIntegrationOptions extends IntegrateAgentOptions {
  installSecretsHooks?: boolean;
  /** Write the secrets-on-read marker block into `.codex/AGENTS.md`. */
  installSecretsInstructions?: boolean;
  /** Write the SQAA marker block into `.codex/AGENTS.md`. */
  installSqaaInstructions?: boolean;
  installMcp?: boolean;
  installContextAugmentation?: boolean;
}

export const codexIntegration: IntegrationDeclaration<CodexIntegrationOptions> = {
  id: CODEX_INTEGRATION_ID,
  displayName: 'Codex',
  features: [
    createSonarSecretsHooksFeature({
      agentDisplayName: 'Codex',
      configDir: CODEX_CONFIG_DIR,
      hooksConfigFileName: HOOKS_FILE,
      hooksPatchId: 'codex-hooks-secrets-hook',
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
    {
      id: 'secrets-instructions',
      displayName: 'secrets-on-read instructions',
      shouldInstall: ({ options }) => options.installSecretsInstructions === true,
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
      id: 'sqaa-instructions',
      displayName: 'SonarQube Agentic Analysis instructions',
      shouldInstall: ({ options }) => options.installSqaaInstructions === true,
      resources: [
        textSnippet({
          id: 'codex-sqaa-instructions',
          displayName: 'Codex AGENTS.md SQAA instructions',
          targetPath: resolveCodexAgentsMdPath,
          startMarker: sonarBeginMarker('sonarqube-agentic-analysis-protocol'),
          endMarker: sonarEndMarker('sonarqube-agentic-analysis-protocol'),
          content: (context) =>
            buildSqaaSectionBody(
              getRequiredStringAttr(context, 'projectKey', codexIntegration.displayName),
            ),
        }),
      ],
    },
    {
      id: 'mcp-server',
      displayName: 'MCP server',
      shouldInstall: ({ options }) => options.installMcp === true,
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
    createContextAugmentationFeature<CodexIntegrationOptions>({
      agentDisplayName: 'Codex',
      targetPath: resolveCodexSkillPath,
    }),
  ],
};

function resolveCodexAgentsMdPath(context: IntegrationContext): string {
  return join(context.targetRoot, CODEX_CONFIG_DIR, AGENTS_MD_FILE);
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

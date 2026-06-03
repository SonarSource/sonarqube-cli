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
import { createContextAugmentationFeature } from '../_common/features/context-augmentation-feature';
import { createSonarSecretsHooksFeature } from '../_common/features/sonar-secrets-hooks-feature';
import { tomlPatch, wholeFile } from '../_common/registry/resources';
import type { IntegrationContext, IntegrationDeclaration } from '../_common/registry/types';
import type { IntegrateAgentOptions } from '../_common/types';
import { getSecretPromptTemplateUnix, getSecretPromptTemplateWindows } from './hook-templates';
import { buildAgentsMdContent } from './instructions-templates';

const CODEX_CONFIG_DIR = '.codex';
const HOOKS_FILE = 'hooks.json';
const AGENTS_MD_FILE = 'AGENTS.md';
const PROMPT_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';

export const CODEX_INTEGRATION_ID = 'codex';

export interface CodexIntegrationOptions extends IntegrateAgentOptions {
  installSecretsHooks?: boolean;
  /** Render the pre-tool secrets-on-read section into `.codex/AGENTS.md`. */
  installSecretsInstructions?: boolean;
  /** Render the post-tool SQAA section into `.codex/AGENTS.md`. */
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
      id: 'agents-md-instructions',
      displayName: 'Codex AGENTS.md instructions',
      // Fires whenever at least one section is enabled. Each section's
      // inclusion is then decided from attrs by the content function, so the
      // two flags act as independent toggles even though both sections share
      // a single file.
      when: ({ options }) =>
        options.installSecretsInstructions === true || options.installSqaaInstructions === true,
      resources: [
        wholeFile({
          id: 'codex-agents-md',
          displayName: 'Codex AGENTS.md',
          targetPath: resolveCodexAgentsMdPath,
          content: (context) =>
            buildAgentsMdContent({
              includeSecrets: getOptionalBoolAttr(context, 'includeSecretsSection'),
              includeSqaa: getOptionalBoolAttr(context, 'includeSqaa'),
              projectKey: getOptionalStringAttr(context, 'projectKey'),
            }),
        }),
      ],
    },
    {
      id: 'mcp-server',
      displayName: 'MCP server',
      when: ({ options }) => options.installMcp === true,
      resources: [
        tomlPatch({
          id: 'codex-mcp-config',
          displayName: 'Codex MCP configuration',
          targetPath: resolveCodexMcpConfigPath,
          defaultValue: {},
          patch: (document, context) => upsertCodexMcpServer(document, context),
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

function getOptionalStringAttr(context: IntegrationContext, key: string): string | undefined {
  const value = context.attrs?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getOptionalBoolAttr(context: IntegrationContext, key: string): boolean {
  return context.attrs?.[key] === true;
}

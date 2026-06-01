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
import { CommandFailedError } from '../../_common/error';
import { createSonarSecretsHooksFeature } from '../_common/features/sonar-secrets-hooks-feature';
import {
  buildSqaaBody,
  SQAA_END_MARKER,
  SQAA_START_MARKER,
} from '../_common/instructions-templates';
import { isFeatureInstalled } from '../_common/registry/installer';
import { textSnippet, tomlPatch } from '../_common/registry/resources';
import type { IntegrationContext, IntegrationDeclaration } from '../_common/registry/types';
import { resolveSqaaFeatureCondition } from '../_common/sqaa-entitlement';
import type { IntegrateAgentOptions } from '../_common/types';
import { getSecretPromptTemplateUnix, getSecretPromptTemplateWindows } from './hook-templates';
import {
  CODEX_SECRETS_BODY,
  CODEX_SECRETS_END_MARKER,
  CODEX_SECRETS_START_MARKER,
} from './instructions-templates';

const CODEX_CONFIG_DIR = '.codex';
const HOOKS_FILE = 'hooks.json';
const AGENTS_MD_FILE = 'AGENTS.md';
const PROMPT_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';

export const CODEX_INTEGRATION_ID = 'codex';

export interface CodexIntegrationOptions extends IntegrateAgentOptions {
  projectRoot?: string;
  serverURL?: string;
  token?: string;
  organization?: string;
  projectKey?: string;
}

export const codexIntegration: IntegrationDeclaration<CodexIntegrationOptions> = {
  id: CODEX_INTEGRATION_ID,
  displayName: 'Codex',
  features: [
    createSonarSecretsHooksFeature({
      integrationId: CODEX_INTEGRATION_ID,
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
      displayName: 'Codex secrets-on-read instructions',
      hint: 'tells Codex to scan files for secrets before reading',
      when: ({ scope, state }) => {
        if (scope === 'global') return { kind: 'ask' };
        const globalExists = isFeatureInstalled(
          state,
          CODEX_INTEGRATION_ID,
          'secrets-instructions',
          'global',
        );
        return globalExists
          ? {
              kind: 'ask',
              question:
                'Global Codex instructions already exist. Also create a project-local copy?',
            }
          : { kind: 'ask' };
      },
      resources: [
        textSnippet({
          id: 'codex-secrets-instructions-file',
          displayName: 'Codex secrets-on-read instructions',
          targetPath: resolveCodexAgentsMdPath,
          content: CODEX_SECRETS_BODY,
          startMarker: CODEX_SECRETS_START_MARKER,
          endMarker: CODEX_SECRETS_END_MARKER,
        }),
      ],
    },
    {
      id: 'sqaa-instructions',
      displayName: 'agentic analysis',
      hint: 'on-demand analysis',
      when: ({ options }) => resolveSqaaFeatureCondition(options),
      targetRoot: ({ options, targetRoot }) => options.projectRoot ?? targetRoot,
      scope: 'project',
      resources: [
        textSnippet({
          id: 'codex-sqaa-instructions-file',
          displayName: 'Codex SQAA instructions',
          targetPath: resolveCodexAgentsMdPath,
          content: (context) => buildSqaaBody(getRequiredStringAttr(context, 'projectKey')),
          startMarker: SQAA_START_MARKER,
          endMarker: SQAA_END_MARKER,
        }),
      ],
    },
    {
      id: 'mcp-server',
      displayName: 'MCP Server',
      hint: 'gives Codex access to SonarQube data',
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
  ],
};

function resolveCodexAgentsMdPath(context: IntegrationContext): string {
  return join(context.targetRoot, CODEX_CONFIG_DIR, AGENTS_MD_FILE);
}

function resolveCodexMcpConfigPath(context: IntegrationContext): string {
  return getMcpConfigFilePath('codex', context.scope === 'global', context.targetRoot);
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

function getRequiredStringAttr(context: IntegrationContext, key: string): string {
  const value = getOptionalStringAttr(context, key);
  if (!value) {
    throw new CommandFailedError(`Missing required integration attribute: ${key}`);
  }
  return value;
}

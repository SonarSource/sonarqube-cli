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
import { createSonarSecretsHooksFeature } from '../_common/features/sonar-secrets-hooks-feature';
import { resolveAgentHookCommand } from '../_common/hooks';
import { buildSqaaSectionBody } from '../_common/instructions-templates';
import { removeJsonMcpServer, upsertJsonMcpServer } from '../_common/mcp-config';
import type { IntegrationContext, IntegrationDeclaration } from '../_common/registry';
import { askUser, jsonPatch, skip, wholeFile } from '../_common/registry';
import type { IntegrateAgentOptions } from '../_common/types';
import { getSecretPromptTemplateUnix, getSecretPromptTemplateWindows } from './hook-templates';
import { removeCursorHook, upsertCursorHook } from './hooks';

export const CURSOR_CONFIG_DIR = '.cursor';

export const CURSOR_INTEGRATION_ID = 'cursor';

const HOOKS_FILE = 'hooks.json';
const PROMPT_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';
const SECRETS_PROMPT_HOOK_FEATURE_ID = 'sonar-secrets-prompt-hook';
const SONAR_SECRETS_MARKER = 'sonar-secrets';
const BEFORE_SUBMIT_PROMPT_EVENT = 'beforeSubmitPrompt';
const RULES_DIR = 'rules';
const SQAA_RULE_FILE = 'sonar-agentic-analysis.mdc';
// Stable string always present in the rendered rule body — used by the
// wholeFile remover so teardown only deletes the file we manage.
const SQAA_RULE_MARKER = '# SonarQube Agentic Analysis protocol';

export interface CursorIntegrationOptions extends IntegrateAgentOptions {
  globalSecretsHookExists?: boolean;
  /**
   * Write the SonarQube Agentic Analysis rule (`.cursor/rules`) instructing the
   * agent to run `sonar analyze agentic` after edits. Cursor's `afterFileEdit`
   * hook cannot inject analysis results back into the conversation, so SQAA is
   * delivered as an always-applied rule rather than a hook (project scope).
   */
  installSqaaInstructions?: boolean;
}

function resolveCursorMcpConfigPath(context: IntegrationContext): string {
  return getMcpConfigFilePath('cursor', context.scope === 'global', context.targetRoot);
}

function getDesiredCursorMcpConfig(context: IntegrationContext) {
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

function resolveCursorSqaaRulePath(context: IntegrationContext): string {
  return join(context.targetRoot, CURSOR_CONFIG_DIR, RULES_DIR, SQAA_RULE_FILE);
}

/**
 * Render the SonarQube Agentic Analysis rule as a Cursor `.mdc` file. The
 * `alwaysApply: true` front-matter makes Cursor inject the protocol into every
 * session without the user attaching it manually.
 */
function buildCursorSqaaRule(context: IntegrationContext): string {
  const projectKey = getRequiredStringAttr(context, 'projectKey', cursorIntegration.displayName);
  return `---\nalwaysApply: true\n---\n\n${buildSqaaSectionBody(projectKey)}`;
}

export const cursorIntegration: IntegrationDeclaration<CursorIntegrationOptions> = {
  id: CURSOR_INTEGRATION_ID,
  displayName: 'Cursor',
  features: [
    createSonarSecretsHooksFeature<CursorIntegrationOptions>({
      agentDisplayName: 'Cursor',
      integrationId: CURSOR_INTEGRATION_ID,
      configDir: CURSOR_CONFIG_DIR,
      hooksConfigFileName: HOOKS_FILE,
      hooksPatchId: 'cursor-hooks-secrets-hook',
      featureId: SECRETS_PROMPT_HOOK_FEATURE_ID,
      displayName: 'Secret scanning hook for prompts',
      scripts: [
        {
          id: 'prompt-secrets-script',
          displayName: 'Cursor beforeSubmitPrompt hook script',
          scriptPath: PROMPT_SCRIPT_REL,
          content: {
            unix: getSecretPromptTemplateUnix(),
            windows: getSecretPromptTemplateWindows(),
          },
        },
      ],
      hookEntries: [
        {
          eventType: BEFORE_SUBMIT_PROMPT_EVENT,
          marker: SONAR_SECRETS_MARKER,
          scriptPath: PROMPT_SCRIPT_REL,
        },
      ],
      // Cursor's hooks.json uses a flat `{ command }` schema wrapped in `{ version, hooks }`,
      // unlike the nested Claude/Codex shape the factory writes by default.
      hookWriter: {
        defaultValue: { version: 1, hooks: {} },
        patch: (document, context, entries, configDir) =>
          entries.reduce(
            (doc, entry) =>
              upsertCursorHook(
                doc,
                entry.eventType,
                resolveAgentHookCommand(context, configDir, entry.scriptPath),
                entry.marker,
              ),
            document,
          ),
        removePatch: (document, markers) =>
          markers.reduce((doc, marker) => removeCursorHook(doc, marker), document),
      },
    }),
    {
      id: 'sqaa-instructions',
      displayName: 'SonarQube Agentic Analysis instructions',
      shouldInstall: ({ options }) =>
        options.installSqaaInstructions === true ? askUser() : skip(),
      scope: 'project',
      resources: [
        wholeFile({
          id: 'sqaa-instructions-rule',
          displayName: 'Cursor SonarQube Agentic Analysis rule',
          targetPath: resolveCursorSqaaRulePath,
          content: buildCursorSqaaRule,
          managedMarker: SQAA_RULE_MARKER,
        }),
      ],
    },
    {
      id: 'mcp-server',
      displayName: 'MCP server',
      resources: [
        jsonPatch({
          id: 'cursor-mcp-config',
          displayName: 'Cursor MCP configuration',
          targetPath: resolveCursorMcpConfigPath,
          defaultValue: {},
          patch: (document, context) =>
            upsertJsonMcpServer(document, getDesiredCursorMcpConfig(context)),
          removePatch: (document) => removeJsonMcpServer(document),
        }),
      ],
    },
  ],
};

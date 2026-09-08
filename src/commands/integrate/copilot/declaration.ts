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

import type {
  IntegrationContext,
  IntegrationDeclaration,
  ResourceDeclaration,
} from '@/core/framework/features';
import {
  askUser,
  jsonPatch,
  skip,
  sonarSecretsBinaryDependency,
  textSnippet,
  wholeFile,
} from '@/core/framework/features';
import { getMcpConfig, getMcpConfigFilePath } from '@/core/host/mcp/mcp-helper.ts';

import { getOptionalStringAttr } from '../_common/attrs.ts';
import {
  MCP_SERVER_FEATURE_BENEFIT,
  MCP_SERVER_FEATURE_PREVIEW,
  SECRETS_PRE_TOOL_USE_FEATURE_BENEFIT,
  SECRETS_PRE_TOOL_USE_FEATURE_PREVIEW,
  SECRETS_PROMPT_FEATURE_BENEFIT,
  SECRETS_PROMPT_FEATURE_PREVIEW,
} from '../_common/feature-constants.ts';
import {
  createContextAugmentationSubfeature,
  SESSION_START_SCRIPT_REL,
  VORTEX_HOOK_MARKER,
} from '../_common/features/context-augmentation-feature.ts';
import { secretsScanningExample } from '../_common/features/sonar-secrets-hooks-feature.ts';
import {
  createSqaaInstructionsSnippet,
  createSqaaInstructionsSubfeature,
} from '../_common/features/sqaa-instructions-feature.ts';
import {
  buildUnixHookScript,
  buildWindowsHookScript,
  hookScriptExtension,
  SONAR_SECRETS_MARKER,
} from '../_common/hooks.ts';
import { sonarBeginMarker, sonarEndMarker } from '../_common/instructions-templates.ts';
import { removeJsonMcpServer, upsertJsonMcpServer } from '../_common/mcp-config.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { createVortexFeature } from '../_common/vortex.ts';
import {
  buildCopilotHookEntry,
  HOOKS_JSON,
  hookScriptName,
  PROJECT_HOOKS_REL_DIR,
  removeCopilotHooks,
  resolveCopilotHookCommandPath,
  SCRIPT_REL_DIR,
  upsertCopilotHooks,
} from './hooks.ts';
import {
  globalCopilotInstructionsExist,
  INSTRUCTIONS_FILENAME,
  PROJECT_INSTRUCTIONS_REL_DIR,
  PROMPT_SECRETS_BODY,
} from './instructions.ts';

export const COPILOT_INTEGRATION_ID = 'copilot-cli';
export const COPILOT_HOOKS_CONFIG_RESOURCE_ID = 'copilot-hooks-config';
const COPILOT_DISPLAY_NAME = 'Copilot';

export interface CopilotIntegrationOptions extends IntegrateAgentOptions {
  globalSecretsHookExists?: boolean;
}

export const copilotIntegration: IntegrationDeclaration<CopilotIntegrationOptions> = {
  id: COPILOT_INTEGRATION_ID,
  displayName: COPILOT_DISPLAY_NAME,
  features: [
    {
      id: 'pre-tool-use-hook',
      displayName: 'pre-tool-use hook',
      benefitDescription: SECRETS_PRE_TOOL_USE_FEATURE_BENEFIT,
      previewDescription: SECRETS_PRE_TOOL_USE_FEATURE_PREVIEW,
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
            unix: buildUnixHookScript('copilot-pre-tool-use'),
            windows: buildWindowsHookScript('copilot-pre-tool-use'),
          },
          executable: true,
        }),
        jsonPatch({
          id: 'copilot-hooks-config',
          displayName: 'Copilot hooks configuration',
          targetPath: resolveHooksJsonPath,
          defaultValue: { version: 1, hooks: {} },
          patch: (document, context) =>
            upsertCopilotHooks(document, SONAR_SECRETS_MARKER, {
              preToolUse: buildCopilotHookEntry(
                resolveCopilotHookCommandPath(context, resolveCopilotHookScriptPath(context)),
              ),
            }),
          removePatch: (document) => removeCopilotHooks(document, [SONAR_SECRETS_MARKER]),
        }),
      ],
    },
    {
      id: 'prompt-secrets-instructions',
      displayName: 'prompt-secrets instructions',
      benefitDescription: SECRETS_PROMPT_FEATURE_BENEFIT,
      previewDescription: SECRETS_PROMPT_FEATURE_PREVIEW,
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
    createVortexFeature<CopilotIntegrationOptions>(
      [
        createSqaaInstructionsSubfeature([createSqaaInstructionsSnippet(resolveInstructionsPath)]),
        createContextAugmentationSubfeature<CopilotIntegrationOptions>({
          agent: 'copilot',
          scriptPath: resolveCagHookScriptPath,
          hookConfigResource: createCagHookConfigResource(),
        }),
      ],
      resolveCopilotSkillPath,
    ),
    {
      id: 'mcp-server',
      displayName: 'MCP server',
      benefitDescription: MCP_SERVER_FEATURE_BENEFIT,
      previewDescription: MCP_SERVER_FEATURE_PREVIEW,
      resources: [
        jsonPatch({
          id: 'copilot-mcp-config',
          displayName: 'Copilot MCP configuration',
          targetPath: resolveCopilotMcpConfigPath,
          defaultValue: {},
          patch: (document, context) =>
            upsertJsonMcpServer(document, getDesiredCopilotMcpConfig(context)),
          removePatch: (document) => removeJsonMcpServer(document),
        }),
      ],
    },
  ],
};

function createCagHookConfigResource(): ResourceDeclaration {
  return jsonPatch({
    id: COPILOT_HOOKS_CONFIG_RESOURCE_ID,
    displayName: 'Copilot session start hook configuration',
    targetPath: resolveHooksJsonPath,
    defaultValue: { version: 1, hooks: {} },
    patch: (document, context) => {
      const entry = buildCopilotHookEntry(
        resolveCopilotHookCommandPath(context, resolveCagHookScriptPath(context)),
      );
      return upsertCopilotHooks(document, VORTEX_HOOK_MARKER, {
        sessionStart: entry,
        subagentStart: entry,
      });
    },
    removePatch: (document) => removeCopilotHooks(document, [VORTEX_HOOK_MARKER]),
  });
}

function resolveCopilotHookScriptPath(context: IntegrationContext): string {
  return join(resolveHooksDir(context), SCRIPT_REL_DIR, hookScriptName());
}

function resolveCagHookScriptPath(context: IntegrationContext): string {
  return join(resolveHooksDir(context), `${SESSION_START_SCRIPT_REL}${hookScriptExtension()}`);
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

function getDesiredCopilotMcpConfig(context: IntegrationContext) {
  return getMcpConfig(
    context.scope === 'global'
      ? { withFsMount: false }
      : {
          withFsMount: true,
          projectRoot: context.targetRoot,
          projectKey: getOptionalStringAttr(context, 'projectKey'),
        },
  );
}

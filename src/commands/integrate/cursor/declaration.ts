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

import { CURSOR_CONFIG_DIR } from '@/core/config-constants.ts';
import type { IntegrationContext, IntegrationDeclaration } from '@/core/framework/features';
import {
  askUser,
  isFeatureInstalledGloballyForProject,
  jsonPatch,
  skip,
  sonarSecretsBinaryDependency,
  wholeFile,
} from '@/core/framework/features';
import { getMcpConfig, getMcpConfigFilePath } from '@/core/host/mcp/mcp-helper.ts';

import { getOptionalStringAttr } from '../_common/attrs.ts';
import {
  MCP_SERVER_FEATURE_BENEFIT,
  MCP_SERVER_FEATURE_PREVIEW,
  SECRETS_COMBINED_FEATURE_BENEFIT,
  SECRETS_COMBINED_FEATURE_PREVIEW,
} from '../_common/feature-constants.ts';
import { createContextAugmentationSubfeature } from '../_common/features/context-augmentation-feature.ts';
import {
  resolveAgentHooksConfigPath,
  secretsScanningExample,
} from '../_common/features/sonar-secrets-hooks-feature.ts';
import {
  createSqaaInstructionsRule,
  createSqaaInstructionsSubfeature,
} from '../_common/features/sqaa-instructions-feature.ts';
import { resolveAgentHookScriptPath } from '../_common/hooks.ts';
import { removeJsonMcpServer, upsertJsonMcpServer } from '../_common/mcp-config.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { createVortexFeature } from '../_common/vortex.ts';
import {
  getSecretPreFileReadTemplateUnix,
  getSecretPreFileReadTemplateWindows,
  getSecretPreToolUseTemplateUnix,
  getSecretPreToolUseTemplateWindows,
  getSecretPromptTemplateUnix,
  getSecretPromptTemplateWindows,
} from './hook-templates.ts';
import { buildCursorHookEntry, removeCursorHooks, upsertCursorHooks } from './hooks.ts';
import { buildCursorAlwaysOnRule } from './rules.ts';

const HOOKS_JSON = 'hooks.json';
const PREREAD_SCRIPT_REL = 'sonar-secrets/build-scripts/before-read-file-secrets';
const PRETOOL_SCRIPT_REL = 'sonar-secrets/build-scripts/pre-tool-use-secrets';
const PROMPT_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';

export const CURSOR_INTEGRATION_ID = 'cursor';

const RULES_DIR = 'rules';
const SQAA_RULE_FILE = 'sonar-agentic-analysis.mdc';
// Shared cross-tool skills directory. Cursor reads `.agents/skills` (same as
// Codex and Antigravity), so the CAG skill is written there rather than to a
// Cursor-specific `.cursor/skills` to avoid a duplicate skill of the same name.
const AGENTS_SKILLS_DIR = join('.agents', 'skills');
const CAG_SKILL_NAME = 'sonar-context-augmentation';

export interface CursorIntegrationOptions extends IntegrateAgentOptions {
  globalSecretsHookExists?: boolean;
}

function resolveCursorMcpConfigPath(context: IntegrationContext): string {
  return getMcpConfigFilePath('cursor', context.scope === 'global', context.targetRoot);
}

function getDesiredCursorMcpConfig(context: IntegrationContext) {
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

function resolveCursorSqaaRulePath(context: IntegrationContext): string {
  return join(context.targetRoot, CURSOR_CONFIG_DIR, RULES_DIR, SQAA_RULE_FILE);
}

// Context Augmentation is delivered as a native, on-demand skill (the same
// rendered SKILL.md the other agents receive), written to the shared
// `.agents/skills` directory that Cursor auto-discovers — not an always-applied
// rule, and not a Cursor-private `.cursor/skills` copy that would duplicate the
// skill Codex/Antigravity already install there.
function resolveCursorCagSkillPath(context: IntegrationContext): string {
  return join(context.targetRoot, AGENTS_SKILLS_DIR, CAG_SKILL_NAME, 'SKILL.md');
}

function resolveCursorHooksJsonPath(context: IntegrationContext): string {
  return resolveAgentHooksConfigPath(context, CURSOR_CONFIG_DIR, HOOKS_JSON);
}

export const cursorIntegration: IntegrationDeclaration<CursorIntegrationOptions> = {
  id: CURSOR_INTEGRATION_ID,
  displayName: 'Cursor',
  features: [
    {
      id: 'sonar-secrets-hooks',
      displayName: 'secret scanning hooks',
      benefitDescription: SECRETS_COMBINED_FEATURE_BENEFIT,
      previewDescription: SECRETS_COMBINED_FEATURE_PREVIEW,
      shouldInstall: ({ options, scope, state }) => {
        const globalHookExists =
          options.globalSecretsHookExists ??
          isFeatureInstalledGloballyForProject(
            state,
            scope,
            CURSOR_INTEGRATION_ID,
            'sonar-secrets-hooks',
          );
        return globalHookExists
          ? skip(
              'A global secrets scanning hook is already configured. Skipping project-level secrets hooks to avoid duplicate execution.',
            )
          : askUser();
      },
      postInstallExample: secretsScanningExample('Cursor'),
      dependencies: [sonarSecretsBinaryDependency],
      resources: [
        wholeFile({
          id: 'preread-secrets-script',
          displayName: 'Cursor beforeReadFile hook script',
          targetPath: (context) =>
            resolveAgentHookScriptPath(context, CURSOR_CONFIG_DIR, PREREAD_SCRIPT_REL),
          content: {
            unix: getSecretPreFileReadTemplateUnix(),
            windows: getSecretPreFileReadTemplateWindows(),
          },
          executable: true,
        }),
        wholeFile({
          id: 'pretool-secrets-script',
          displayName: 'Cursor preToolUse hook script',
          targetPath: (context) =>
            resolveAgentHookScriptPath(context, CURSOR_CONFIG_DIR, PRETOOL_SCRIPT_REL),
          content: {
            unix: getSecretPreToolUseTemplateUnix(),
            windows: getSecretPreToolUseTemplateWindows(),
          },
          executable: true,
        }),
        wholeFile({
          id: 'prompt-secrets-script',
          displayName: 'Cursor beforeSubmitPrompt hook script',
          targetPath: (context) =>
            resolveAgentHookScriptPath(context, CURSOR_CONFIG_DIR, PROMPT_SCRIPT_REL),
          content: {
            unix: getSecretPromptTemplateUnix(),
            windows: getSecretPromptTemplateWindows(),
          },
          executable: true,
        }),
        jsonPatch({
          id: 'cursor-hooks-config',
          displayName: 'Cursor hooks configuration',
          targetPath: resolveCursorHooksJsonPath,
          defaultValue: { version: 1, hooks: {} },
          patch: (document, context) =>
            upsertCursorHooks(document, [
              buildCursorHookEntry(context, CURSOR_CONFIG_DIR, 'preToolUse', PRETOOL_SCRIPT_REL),
              buildCursorHookEntry(
                context,
                CURSOR_CONFIG_DIR,
                'beforeReadFile',
                PREREAD_SCRIPT_REL,
              ),
              buildCursorHookEntry(
                context,
                CURSOR_CONFIG_DIR,
                'beforeSubmitPrompt',
                PROMPT_SCRIPT_REL,
              ),
            ]),
          removePatch: (document) => removeCursorHooks(document, ['sonar-secrets']),
        }),
      ],
    },
    createVortexFeature<CursorIntegrationOptions>([
      createSqaaInstructionsSubfeature([
        createSqaaInstructionsRule(resolveCursorSqaaRulePath, buildCursorAlwaysOnRule),
      ]),
      createContextAugmentationSubfeature<CursorIntegrationOptions>({
        targetPath: resolveCursorCagSkillPath,
      }),
    ]),
    {
      id: 'mcp-server',
      displayName: 'MCP server',
      benefitDescription: MCP_SERVER_FEATURE_BENEFIT,
      previewDescription: MCP_SERVER_FEATURE_PREVIEW,
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

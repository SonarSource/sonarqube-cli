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
  FeatureContainer,
  FeatureDeclaration,
  IntegrationContext,
  IntegrationDeclaration,
  ResourceDeclaration,
  SubfeatureDeclaration,
} from '@/core/framework/features';
import { jsonPatch, textSnippet, wholeFile } from '@/core/framework/features';
import { resolveDevinConfigDir } from '@/core/host/environment/devin-config-dir.ts';

import {
  SECRETS_COMBINED_FEATURE_PREVIEW,
  SECRETS_PRE_TOOL_USE_FEATURE_PREVIEW,
} from '../_common/feature-constants.ts';
import {
  createContextAugmentationSubfeature,
  SESSION_START_SCRIPT_REL,
  VORTEX_HOOK_MARKER,
} from '../_common/features/context-augmentation-feature.ts';
import { createMcpServerFeature } from '../_common/features/mcp-server-feature.ts';
import { createSonarSecretsHooksFeature } from '../_common/features/sonar-secrets-hooks-feature.ts';
import {
  createSqaaInstructionsSnippet,
  createSqaaInstructionsSubfeature,
  SQAA_HOOK_FEATURE_ID,
} from '../_common/features/sqaa-instructions-feature.ts';
import {
  buildUnixHookScript,
  buildWindowsHookScript,
  createAgentHookEntry,
  removeAgentHooks,
  resolveAgentHookScriptPath,
  upsertAgentHooks,
} from '../_common/hooks.ts';
import {
  SECRETS_ON_READ_BODY,
  sonarBeginMarker,
  sonarEndMarker,
} from '../_common/instructions-templates.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { createVortexFeature } from '../_common/vortex.ts';

export const DEVIN_INTEGRATION_ID = 'devin';
const DEVIN_DISPLAY_NAME = 'Devin';

export type DevinIntegrationOptions = IntegrateAgentOptions;

const DEVIN_MCP_CONFIG_FILE = 'mcp_config.json';
const DEVIN_CONFIG_FILE = 'config.json';
const DEVIN_AGENTS_MD_FILE = 'AGENTS.md';
const POSTTOOL_SQAA_SCRIPT_REL = 'sonar-sqaa/build-scripts/posttool-sqaa';
const SQAA_HOOK_MARKER = 'sonar-sqaa';
// Devin tool names are lowercase and the matcher is case-sensitive.
const SQAA_HOOK_MATCHER = '^(edit|write)$';
// SessionStart has no tool name to match; Devin documents an empty matcher for non-tool events.
const SESSION_START_HOOK_MATCHER = '';
const PRETOOL_SECRETS_SCRIPT_REL = 'sonar-secrets/build-scripts/pretool-secrets';
const PROMPT_SECRETS_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';
const SECRETS_HOOK_MARKER = 'sonar-secrets';
const READ_HOOK_MATCHER = '^read$';
const SECRETS_ON_READ_MARKER = 'devin-secrets-on-read';

export function resolveDevinMcpConfigPath(
  context: IntegrationContext,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(resolveDevinConfigDir(context.targetRoot, env, platform), DEVIN_MCP_CONFIG_FILE);
}

// Global hooks live under the `hooks` key of `config.json`; Devin does not read a standalone
// global `hooks.v1.json`.
export function resolveDevinConfigPath(
  context: IntegrationContext,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(resolveDevinConfigDir(context.targetRoot, env, platform), DEVIN_CONFIG_FILE);
}

export function resolveDevinAgentsMdPath(
  context: IntegrationContext,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(resolveDevinConfigDir(context.targetRoot, env, platform), DEVIN_AGENTS_MD_FILE);
}

// The shared hook helpers join `targetRoot` with a config dir; rooting them at the resolved Devin
// config dir keeps hook scripts and commands correct where it is not `<home>/<name>` (Windows %APPDATA%).
function devinHookContext(context: IntegrationContext): IntegrationContext {
  return { ...context, targetRoot: resolveDevinConfigDir(context.targetRoot) };
}

function createDevinSecretsHooksFeature(): FeatureDeclaration<DevinIntegrationOptions> {
  return createSonarSecretsHooksFeature<DevinIntegrationOptions>({
    agentDisplayName: DEVIN_DISPLAY_NAME,
    configDir: '',
    hooksConfigFileName: DEVIN_CONFIG_FILE,
    hooksPatchId: 'devin-hooks-secrets-hook',
    previewDescription: SECRETS_COMBINED_FEATURE_PREVIEW,
    resolveContext: devinHookContext,
    scripts: [
      {
        id: 'pretool-secrets-script',
        displayName: 'Devin PreToolUse hook script',
        scriptPath: PRETOOL_SECRETS_SCRIPT_REL,
        content: {
          unix: buildUnixHookScript('devin-pre-tool-use'),
          windows: buildWindowsHookScript('devin-pre-tool-use'),
        },
      },
      {
        id: 'prompt-secrets-script',
        displayName: 'Devin UserPromptSubmit hook script',
        scriptPath: PROMPT_SECRETS_SCRIPT_REL,
        content: {
          unix: buildUnixHookScript('devin-prompt-submit'),
          windows: buildWindowsHookScript('devin-prompt-submit'),
        },
      },
    ],
    hookEntries: [
      {
        eventType: 'PreToolUse',
        matcher: READ_HOOK_MATCHER,
        marker: SECRETS_HOOK_MARKER,
        scriptPath: PRETOOL_SECRETS_SCRIPT_REL,
      },
      {
        eventType: 'UserPromptSubmit',
        matcher: '',
        marker: SECRETS_HOOK_MARKER,
        scriptPath: PROMPT_SECRETS_SCRIPT_REL,
      },
    ],
  });
}

function createSecretsInstructionsFeature(): FeatureDeclaration<DevinIntegrationOptions> {
  return {
    id: 'secrets-instructions',
    displayName: 'secrets-on-read instructions',
    previewDescription: SECRETS_PRE_TOOL_USE_FEATURE_PREVIEW,
    resources: [
      textSnippet({
        id: 'devin-secrets-instructions',
        displayName: 'Devin AGENTS.md secrets instructions',
        targetPath: resolveDevinAgentsMdPath,
        startMarker: sonarBeginMarker(SECRETS_ON_READ_MARKER),
        endMarker: sonarEndMarker(SECRETS_ON_READ_MARKER),
        content: SECRETS_ON_READ_BODY,
      }),
    ],
  };
}

function createSqaaHookSubfeature(): SubfeatureDeclaration<DevinIntegrationOptions> {
  return {
    id: SQAA_HOOK_FEATURE_ID,
    displayName: 'Vortex analysis hook',
    required: true,
    resources: [
      wholeFile({
        id: 'posttool-sqaa-script',
        displayName: 'Devin PostToolUse hook script',
        targetPath: (context) =>
          resolveAgentHookScriptPath(devinHookContext(context), '', POSTTOOL_SQAA_SCRIPT_REL),
        content: {
          unix: buildUnixHookScript('devin-post-tool-use'),
          windows: buildWindowsHookScript('devin-post-tool-use'),
        },
        executable: true,
      }),
      jsonPatch({
        id: 'devin-hooks-sqaa-hook',
        displayName: 'Devin Vortex analysis hook configuration',
        targetPath: resolveDevinConfigPath,
        defaultValue: { hooks: {} },
        patch: (document, context) =>
          upsertAgentHooks(document, [
            createAgentHookEntry(
              devinHookContext(context),
              '',
              'PostToolUse',
              SQAA_HOOK_MATCHER,
              SQAA_HOOK_MARKER,
              POSTTOOL_SQAA_SCRIPT_REL,
            ),
          ]),
        removePatch: (document) => removeAgentHooks(document, [SQAA_HOOK_MARKER]),
      }),
    ],
  };
}

function createCagHookConfigResource(): ResourceDeclaration {
  return jsonPatch({
    id: 'devin-hooks-config',
    displayName: 'Devin session start hook configuration',
    targetPath: resolveDevinConfigPath,
    defaultValue: { hooks: {} },
    patch: (document, context) =>
      upsertAgentHooks(document, [
        createAgentHookEntry(
          devinHookContext(context),
          '',
          'SessionStart',
          SESSION_START_HOOK_MATCHER,
          VORTEX_HOOK_MARKER,
          SESSION_START_SCRIPT_REL,
        ),
      ]),
    removePatch: (document) => removeAgentHooks(document, [VORTEX_HOOK_MARKER]),
  });
}

function createDevinVortexFeature(): FeatureContainer<DevinIntegrationOptions> {
  return createVortexFeature<DevinIntegrationOptions>([
    createSqaaHookSubfeature(),
    createSqaaInstructionsSubfeature([createSqaaInstructionsSnippet(resolveDevinAgentsMdPath)]),
    createContextAugmentationSubfeature<DevinIntegrationOptions>({
      agent: 'devin',
      scriptPath: (context) =>
        resolveAgentHookScriptPath(devinHookContext(context), '', SESSION_START_SCRIPT_REL),
      hookConfigResource: createCagHookConfigResource(),
    }),
  ]);
}

export const devinIntegration: IntegrationDeclaration<DevinIntegrationOptions> = {
  id: DEVIN_INTEGRATION_ID,
  displayName: DEVIN_DISPLAY_NAME,
  features: [
    createDevinSecretsHooksFeature(),
    createDevinVortexFeature(),
    createSecretsInstructionsFeature(),
    createMcpServerFeature<DevinIntegrationOptions>({
      resolveConfigPath: resolveDevinMcpConfigPath,
      alwaysGlobal: true,
    }),
  ],
};

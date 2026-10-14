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
  IntegrationContext,
  IntegrationDeclaration,
  SubfeatureDeclaration,
} from '@/core/framework/features';
import { jsonPatch, wholeFile } from '@/core/framework/features';
import { resolveDevinConfigDir } from '@/core/host/environment/devin-config-dir.ts';

import { createMcpServerFeature } from '../_common/features/mcp-server-feature.ts';
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

function createDevinVortexFeature(): FeatureContainer<DevinIntegrationOptions> {
  return createVortexFeature<DevinIntegrationOptions>([
    createSqaaHookSubfeature(),
    createSqaaInstructionsSubfeature([createSqaaInstructionsSnippet(resolveDevinAgentsMdPath)]),
  ]);
}

export const devinIntegration: IntegrationDeclaration<DevinIntegrationOptions> = {
  id: DEVIN_INTEGRATION_ID,
  displayName: DEVIN_DISPLAY_NAME,
  features: [
    createDevinVortexFeature(),
    createMcpServerFeature<DevinIntegrationOptions>({
      resolveConfigPath: resolveDevinMcpConfigPath,
      alwaysGlobal: true,
    }),
  ],
};

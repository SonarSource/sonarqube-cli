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
  SubfeatureDeclaration,
} from '@/core/framework/features';
import {
  askUser,
  install,
  isFeatureInstalledGloballyForProject,
  skip,
  sonarSecretsBinaryDependency,
  wholeFile,
} from '@/core/framework/features';

import {
  SECRETS_COMBINED_FEATURE_BENEFIT,
  SECRETS_COMBINED_FEATURE_PREVIEW,
} from '../_common/feature-constants.ts';
import { createContextAugmentationSkillSubfeature } from '../_common/features/context-augmentation-feature.ts';
import { createMcpServerFeature } from '../_common/features/mcp-server-feature.ts';
import { secretsScanningExample } from '../_common/features/sonar-secrets-hooks-feature.ts';
import {
  createSqaaInstructionsSnippet,
  createSqaaInstructionsSubfeature,
  SQAA_HOOK_FEATURE_ID,
} from '../_common/features/sqaa-instructions-feature.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { createVortexFeature } from '../_common/vortex.ts';
import {
  OPENCODE_PLUGIN_MANAGED_MARKER,
  OPENCODE_SECRETS_PLUGIN_CONTENT,
} from './secrets-plugin-content.ts';
import { OPENCODE_SQAA_PLUGIN_CONTENT } from './sqaa-plugin-content.ts';

const OPENCODE_PROJECT_CONFIG_DIR = '.opencode';
const OPENCODE_GLOBAL_CONFIG_DIR = join('.config', 'opencode');
const PLUGINS_DIR = 'plugins';
const SKILLS_DIR = 'skills';
const CAG_SKILL_NAME = 'sonar-context-augmentation';
const SECRETS_PLUGIN_FILE = 'sonar-secrets.ts';
const SQAA_PLUGIN_FILE = 'sonar-sqaa.ts';
const AGENTS_MD_FILE = 'AGENTS.md';
const CONFIG_FILE = 'opencode.json';

export const OPENCODE_INTEGRATION_ID = 'opencode';
const OPENCODE_DISPLAY_NAME = 'OpenCode';
const SECRETS_EXAMPLE_FOOTER =
  '  Sonar will detect the token and mask it before the message is sent.';
const SONAR_SECRETS_HOOKS_FEATURE_ID = 'sonar-secrets-hooks';

export interface OpenCodeIntegrationOptions extends IntegrateAgentOptions {
  globalSecretsHookExists?: boolean;
}

function resolvePluginFilePath(context: IntegrationContext, fileName: string): string {
  return context.scope === 'global'
    ? join(context.targetRoot, OPENCODE_GLOBAL_CONFIG_DIR, PLUGINS_DIR, fileName)
    : join(context.targetRoot, OPENCODE_PROJECT_CONFIG_DIR, PLUGINS_DIR, fileName);
}

export function resolveOpenCodeSecretsPluginPath(context: IntegrationContext): string {
  return resolvePluginFilePath(context, SECRETS_PLUGIN_FILE);
}

export function resolveOpenCodeSqaaPluginPath(context: IntegrationContext): string {
  return resolvePluginFilePath(context, SQAA_PLUGIN_FILE);
}

export function resolveOpenCodeCagSkillPath(context: IntegrationContext): string {
  const configDir =
    context.scope === 'global' ? OPENCODE_GLOBAL_CONFIG_DIR : OPENCODE_PROJECT_CONFIG_DIR;
  return join(context.targetRoot, configDir, SKILLS_DIR, CAG_SKILL_NAME, 'SKILL.md');
}

export function resolveOpenCodeAgentsMdPath(context: IntegrationContext): string {
  return context.scope === 'global'
    ? join(context.targetRoot, OPENCODE_GLOBAL_CONFIG_DIR, AGENTS_MD_FILE)
    : join(context.targetRoot, AGENTS_MD_FILE);
}

function createSqaaPluginSubfeature(): SubfeatureDeclaration<OpenCodeIntegrationOptions> {
  return {
    id: SQAA_HOOK_FEATURE_ID,
    displayName: 'Vortex analysis hook',
    shouldInstall: () => install(),
    resources: [
      wholeFile({
        id: 'opencode-sqaa-plugin',
        displayName: 'OpenCode Vortex analysis plugin',
        targetPath: resolveOpenCodeSqaaPluginPath,
        content: OPENCODE_SQAA_PLUGIN_CONTENT,
        managedMarker: OPENCODE_PLUGIN_MANAGED_MARKER,
      }),
    ],
  };
}

export function resolveOpenCodeMcpConfigPath(context: IntegrationContext): string {
  return context.scope === 'global'
    ? join(context.targetRoot, OPENCODE_GLOBAL_CONFIG_DIR, CONFIG_FILE)
    : join(context.targetRoot, CONFIG_FILE);
}

export const openCodeIntegration: IntegrationDeclaration<OpenCodeIntegrationOptions> = {
  id: OPENCODE_INTEGRATION_ID,
  displayName: OPENCODE_DISPLAY_NAME,
  features: [
    {
      id: SONAR_SECRETS_HOOKS_FEATURE_ID,
      displayName: 'secret scanning hooks',
      benefitDescription: SECRETS_COMBINED_FEATURE_BENEFIT,
      previewDescription: SECRETS_COMBINED_FEATURE_PREVIEW,
      shouldInstall: ({ options, scope, state }) => {
        const globalHookExists =
          options.globalSecretsHookExists ??
          isFeatureInstalledGloballyForProject(
            state,
            scope,
            OPENCODE_INTEGRATION_ID,
            SONAR_SECRETS_HOOKS_FEATURE_ID,
          );
        return globalHookExists
          ? skip(
              'A global secrets scanning hook is already configured. Skipping project-level secrets hooks to avoid duplicate execution.',
            )
          : askUser();
      },
      postInstallExample: secretsScanningExample(OPENCODE_DISPLAY_NAME, SECRETS_EXAMPLE_FOOTER),
      dependencies: [sonarSecretsBinaryDependency],
      resources: [
        wholeFile({
          id: 'opencode-secrets-plugin',
          displayName: 'OpenCode secrets scanning plugin',
          targetPath: resolveOpenCodeSecretsPluginPath,
          content: OPENCODE_SECRETS_PLUGIN_CONTENT,
          managedMarker: OPENCODE_PLUGIN_MANAGED_MARKER,
        }),
      ],
    },
    createVortexFeature<OpenCodeIntegrationOptions>([
      createSqaaPluginSubfeature(),
      createSqaaInstructionsSubfeature<OpenCodeIntegrationOptions>([
        createSqaaInstructionsSnippet(resolveOpenCodeAgentsMdPath),
      ]),
      createContextAugmentationSkillSubfeature<OpenCodeIntegrationOptions>({
        targetPath: resolveOpenCodeCagSkillPath,
        instructionsTargetPath: resolveOpenCodeAgentsMdPath,
      }),
    ]),
    createMcpServerFeature<OpenCodeIntegrationOptions>({
      resolveConfigPath: resolveOpenCodeMcpConfigPath,
      format: 'opencode',
    }),
  ],
};

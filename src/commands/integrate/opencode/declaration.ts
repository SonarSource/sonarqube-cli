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

import type { IntegrationContext, IntegrationDeclaration } from '@/core/framework/features';
import {
  askUser,
  isFeatureInstalledGloballyForProject,
  skip,
  sonarSecretsBinaryDependency,
  wholeFile,
} from '@/core/framework/features';

import {
  SECRETS_COMBINED_FEATURE_BENEFIT,
  SECRETS_COMBINED_FEATURE_PREVIEW,
} from '../_common/feature-constants.ts';
import { createMcpServerFeature } from '../_common/features/mcp-server-feature.ts';
import { secretsScanningExample } from '../_common/features/sonar-secrets-hooks-feature.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { OPENCODE_PLUGIN_CONTENT, OPENCODE_PLUGIN_MANAGED_MARKER } from './plugin-content.ts';

const OPENCODE_PROJECT_CONFIG_DIR = '.opencode';
const OPENCODE_GLOBAL_CONFIG_DIR = join('.config', 'opencode');
const PLUGINS_DIR = 'plugins';
const PLUGIN_FILE = 'sonar.ts';
const CONFIG_FILE = 'opencode.json';

export const OPENCODE_INTEGRATION_ID = 'opencode';
const OPENCODE_DISPLAY_NAME = 'OpenCode';
const SECRETS_EXAMPLE_FOOTER =
  '  Sonar will detect the token and mask it before the message is sent.';
const SONAR_SECRETS_HOOKS_FEATURE_ID = 'sonar-secrets-hooks';

export interface OpenCodeIntegrationOptions extends IntegrateAgentOptions {
  globalSecretsHookExists?: boolean;
}

export function resolveOpenCodePluginPath(context: IntegrationContext): string {
  return context.scope === 'global'
    ? join(context.targetRoot, OPENCODE_GLOBAL_CONFIG_DIR, PLUGINS_DIR, PLUGIN_FILE)
    : join(context.targetRoot, OPENCODE_PROJECT_CONFIG_DIR, PLUGINS_DIR, PLUGIN_FILE);
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
          targetPath: resolveOpenCodePluginPath,
          content: OPENCODE_PLUGIN_CONTENT,
          managedMarker: OPENCODE_PLUGIN_MANAGED_MARKER,
        }),
      ],
    },
    createMcpServerFeature<OpenCodeIntegrationOptions>({
      resolveConfigPath: resolveOpenCodeMcpConfigPath,
      format: 'opencode',
    }),
  ],
};

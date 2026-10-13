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
import { sonarSecretsBinaryDependency, wholeFile } from '@/core/framework/features';

import {
  SECRETS_COMBINED_FEATURE_BENEFIT,
  SECRETS_COMBINED_FEATURE_PREVIEW,
} from '../_common/feature-constants.ts';
import { createMcpServerFeature } from '../_common/features/mcp-server-feature.ts';
import { secretsScanningExample } from '../_common/features/sonar-secrets-hooks-feature.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import {
  PI_EXTENSION_MANAGED_MARKER,
  PI_SECRETS_EXTENSION_CONTENT,
} from './secrets-extension-content.ts';

const PI_PROJECT_CONFIG_DIR = '.pi';
const PI_GLOBAL_CONFIG_DIR = join('.pi', 'agent');
const EXTENSIONS_DIR = 'extensions';
const SECRETS_EXTENSION_FILE = 'sonar-secrets.ts';
const MCP_CONFIG_FILE = 'mcp.json';

export const PI_INTEGRATION_ID = 'pi';
const PI_DISPLAY_NAME = 'Pi';
const SECRETS_EXAMPLE_FOOTER =
  '  Sonar will detect the token and mask it before the message is sent.';
const SONAR_SECRETS_HOOKS_FEATURE_ID = 'sonar-secrets-hooks';

export function resolvePiSecretsExtensionPath(context: IntegrationContext): string {
  const configDir = context.scope === 'global' ? PI_GLOBAL_CONFIG_DIR : PI_PROJECT_CONFIG_DIR;
  return join(context.targetRoot, configDir, EXTENSIONS_DIR, SECRETS_EXTENSION_FILE);
}

export function resolvePiMcpConfigPath(context: IntegrationContext): string {
  const configDir = context.scope === 'global' ? PI_GLOBAL_CONFIG_DIR : PI_PROJECT_CONFIG_DIR;
  return join(context.targetRoot, configDir, MCP_CONFIG_FILE);
}

export const piIntegration: IntegrationDeclaration<IntegrateAgentOptions> = {
  id: PI_INTEGRATION_ID,
  displayName: PI_DISPLAY_NAME,
  features: [
    {
      id: SONAR_SECRETS_HOOKS_FEATURE_ID,
      displayName: 'secret scanning hooks',
      benefitDescription: SECRETS_COMBINED_FEATURE_BENEFIT,
      previewDescription: SECRETS_COMBINED_FEATURE_PREVIEW,
      postInstallExample: secretsScanningExample(PI_DISPLAY_NAME, SECRETS_EXAMPLE_FOOTER),
      dependencies: [sonarSecretsBinaryDependency],
      resources: [
        wholeFile({
          id: 'pi-secrets-extension',
          displayName: 'Pi secrets scanning extension',
          targetPath: resolvePiSecretsExtensionPath,
          content: PI_SECRETS_EXTENSION_CONTENT,
          managedMarker: PI_EXTENSION_MANAGED_MARKER,
        }),
      ],
    },
    createMcpServerFeature<IntegrateAgentOptions>({ resolveConfigPath: resolvePiMcpConfigPath }),
  ],
};

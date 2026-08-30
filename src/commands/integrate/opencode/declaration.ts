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
import { jsonPatch } from '@/core/framework/features';
import { getMcpConfig } from '@/core/host/mcp/mcp-helper.ts';

import { getOptionalStringAttr } from '../_common/attrs.ts';
import {
  MCP_SERVER_FEATURE_BENEFIT,
  MCP_SERVER_FEATURE_PREVIEW,
} from '../_common/feature-constants.ts';
import { createContextAugmentationSubfeature } from '../_common/features/context-augmentation-feature.ts';
import {
  createSqaaInstructionsSnippet,
  createSqaaInstructionsSubfeature,
} from '../_common/features/sqaa-instructions-feature.ts';
import { removeOpenCodeMcpServer, upsertOpenCodeMcpServer } from '../_common/mcp-config.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { createVortexFeature } from '../_common/vortex.ts';

export const OPENCODE_INTEGRATION_ID = 'opencode';
const OPENCODE_DISPLAY_NAME = 'OpenCode';

function resolveOpenCodeConfigPath(context: IntegrationContext): string {
  return context.scope === 'global'
    ? join(context.targetRoot, '.config', 'opencode', 'opencode.json')
    : join(context.targetRoot, 'opencode.json');
}

function getDesiredOpenCodeMcpConfig(context: IntegrationContext) {
  const config = getMcpConfig(
    context.scope === 'global'
      ? { withFsMount: false }
      : {
          withFsMount: true,
          projectRoot: context.targetRoot,
          projectKey: getOptionalStringAttr(context, 'projectKey'),
        },
  );
  const command = [config.command, ...config.args];
  return config.env === undefined
    ? { type: 'local', command }
    : { type: 'local', command, environment: config.env };
}

function resolveOpenCodeInstructionsPath(context: IntegrationContext): string {
  return join(context.targetRoot, 'AGENTS.md');
}

function resolveOpenCodeCagSkillPath(context: IntegrationContext): string {
  return join(context.targetRoot, '.opencode', 'skills', 'sonar-context-augmentation', 'SKILL.md');
}

export const openCodeIntegration: IntegrationDeclaration<IntegrateAgentOptions> = {
  id: OPENCODE_INTEGRATION_ID,
  displayName: OPENCODE_DISPLAY_NAME,
  features: [
    createVortexFeature<IntegrateAgentOptions>([
      createSqaaInstructionsSubfeature([
        createSqaaInstructionsSnippet({
          agentDisplayName: OPENCODE_DISPLAY_NAME,
          targetPath: resolveOpenCodeInstructionsPath,
        }),
      ]),
      createContextAugmentationSubfeature<IntegrateAgentOptions>({
        targetPath: resolveOpenCodeCagSkillPath,
      }),
    ]),
    {
      id: 'mcp-server',
      displayName: 'MCP server',
      benefitDescription: MCP_SERVER_FEATURE_BENEFIT,
      previewDescription: MCP_SERVER_FEATURE_PREVIEW,
      resources: [
        jsonPatch({
          id: 'opencode-mcp-config',
          displayName: 'OpenCode MCP configuration',
          targetPath: resolveOpenCodeConfigPath,
          defaultValue: {},
          patch: (document, context) =>
            upsertOpenCodeMcpServer(document, getDesiredOpenCodeMcpConfig(context)),
          removePatch: (document) => removeOpenCodeMcpServer(document),
        }),
      ],
    },
  ],
};

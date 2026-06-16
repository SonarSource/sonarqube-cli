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

import {
  ANTIGRAVITY_GLOBAL_INSTRUCTIONS_DIR,
  ANTIGRAVITY_GLOBAL_SKILLS_DIR,
  ANTIGRAVITY_INSTRUCTIONS_FILENAME,
  ANTIGRAVITY_PROJECT_AGENTS_DIR,
  ANTIGRAVITY_PROJECT_INSTRUCTIONS_DIR,
} from '../../../../lib/config-constants';
import { createContextAugmentationFeature } from '../_common/features/context-augmentation-feature';
import { secretsScanningExample } from '../_common/features/sonar-secrets-hooks-feature';
import { sonarBeginMarker, sonarEndMarker } from '../_common/instructions-templates';
import type { IntegrationContext, IntegrationDeclaration } from '../_common/registry';
import {
  askUser,
  jsonPatch,
  skip,
  sonarSecretsBinaryDependency,
  textSnippet,
  wholeFile,
} from '../_common/registry';
import type { IntegrateAgentOptions } from '../_common/types';
import { getSecretPreToolTemplateUnix, getSecretPreToolTemplateWindows } from './hook-templates';
import {
  removeAntigravitySecretsBlock,
  resolveAntigravityHooksJsonPath,
  resolvePretoolSecretsScriptPath,
  upsertAntigravitySecretsBlock,
} from './hooks';
import { globalAntigravityInstructionsExist, PROMPT_SECRETS_BODY } from './instructions';

export const ANTIGRAVITY_INTEGRATION_ID = 'antigravity-cli';

export interface AntigravityIntegrationOptions extends IntegrateAgentOptions {
  projectRoot?: string;
  globalSecretsHookExists?: boolean;
  installContextAugmentation?: boolean;
}

export const antigravityIntegration: IntegrationDeclaration<AntigravityIntegrationOptions> = {
  id: ANTIGRAVITY_INTEGRATION_ID,
  displayName: 'Antigravity',
  features: [
    {
      id: 'sonar-secrets-hooks',
      displayName: 'Secret scanning hooks',
      shouldInstall: ({ options }) =>
        options.globalSecretsHookExists === true
          ? skip(
              'Skipping the project-level secrets scanning hooks because a global secrets scanning hook is already configured.',
            )
          : askUser(),
      postInstallExample: secretsScanningExample('Antigravity'),
      dependencies: [sonarSecretsBinaryDependency],
      resources: [
        wholeFile({
          id: 'pretool-secrets-script',
          displayName: 'Antigravity PreToolUse hook script',
          targetPath: resolvePretoolSecretsScriptPath,
          content: {
            unix: getSecretPreToolTemplateUnix(),
            windows: getSecretPreToolTemplateWindows(),
          },
          executable: true,
        }),
        jsonPatch({
          id: 'antigravity-hooks-secrets',
          displayName: 'Antigravity hooks configuration',
          targetPath: resolveAntigravityHooksJsonPath,
          defaultValue: {},
          patch: (document, context) => upsertAntigravitySecretsBlock(document, context),
          removePatch: (document) => removeAntigravitySecretsBlock(document),
        }),
      ],
    },
    {
      id: 'prompt-secrets-instructions',
      displayName: 'Prompt-secrets instructions',
      shouldInstall: ({ scope }) =>
        scope === 'project' && globalAntigravityInstructionsExist()
          ? askUser(
              'Global Antigravity instructions already exist. Do you also want to create a project-local copy for this repo?',
            )
          : askUser(),
      resources: [
        textSnippet({
          id: 'prompt-secrets-instructions-file',
          displayName: 'Antigravity Prompt-secrets instructions',
          targetPath: resolveInstructionsPath,
          startMarker: sonarBeginMarker('antigravity-prompt-secrets'),
          endMarker: sonarEndMarker('antigravity-prompt-secrets'),
          content: PROMPT_SECRETS_BODY,
        }),
      ],
    },
    createContextAugmentationFeature<AntigravityIntegrationOptions>({
      agentDisplayName: 'Antigravity',
      targetPath: resolveAntigravitySkillPath,
    }),
  ],
};

function resolveInstructionsPath(context: IntegrationContext): string {
  return context.scope === 'global'
    ? join(ANTIGRAVITY_GLOBAL_INSTRUCTIONS_DIR, ANTIGRAVITY_INSTRUCTIONS_FILENAME)
    : join(
        context.targetRoot,
        ANTIGRAVITY_PROJECT_INSTRUCTIONS_DIR,
        ANTIGRAVITY_INSTRUCTIONS_FILENAME,
      );
}

function resolveAntigravitySkillPath(context: IntegrationContext): string {
  if (context.scope === 'global') {
    return join(ANTIGRAVITY_GLOBAL_SKILLS_DIR, 'sonar-context-augmentation', 'SKILL.md');
  }
  return join(
    context.targetRoot,
    ANTIGRAVITY_PROJECT_AGENTS_DIR,
    'skills',
    'sonar-context-augmentation',
    'SKILL.md',
  );
}

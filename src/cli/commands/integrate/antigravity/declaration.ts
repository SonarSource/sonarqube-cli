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
  ANTIGRAVITY_GLOBAL_GEMINI_MD,
  ANTIGRAVITY_GLOBAL_MCP_CONFIG_JSON,
  ANTIGRAVITY_GLOBAL_SKILLS_DIR,
  ANTIGRAVITY_LEGACY_GLOBAL_INSTRUCTIONS_PATH,
  ANTIGRAVITY_LEGACY_PROJECT_INSTRUCTIONS_PATH,
  ANTIGRAVITY_PROJECT_AGENTS_DIR,
  ANTIGRAVITY_PROJECT_RULES_DIR,
  ANTIGRAVITY_PROMPT_SECRETS_RULE_FILE,
  ANTIGRAVITY_SQAA_RULE_FILE,
  CLI_COMMAND,
} from '../../../../lib/config-constants';
import { getMcpConfig } from '../../../../lib/mcp/mcp-helper';
import { getRequiredStringAttr } from '../_common/attrs';
import { createContextAugmentationFeature } from '../_common/features/context-augmentation-feature';
import { secretsScanningExample } from '../_common/features/sonar-secrets-hooks-feature';
import {
  buildSqaaSectionBody,
  sonarBeginMarker,
  sonarEndMarker,
} from '../_common/instructions-templates';
import { removeJsonMcpServer, upsertJsonMcpServer } from '../_common/mcp-config';
import type { IntegrationContext, IntegrationDeclaration } from '../_common/registry';
import {
  askUser,
  jsonPatch,
  skip,
  sonarSecretsBinaryDependency,
  textSnippet,
  wholeFile,
  wholeFileRemover,
} from '../_common/registry';
import type { IntegrateAgentOptions } from '../_common/types';
import { getSecretPreToolTemplateUnix, getSecretPreToolTemplateWindows } from './hook-templates';
import {
  removeAntigravitySecretsBlock,
  resolveAntigravityHooksJsonPath,
  resolvePretoolSecretsScriptPath,
  upsertAntigravitySecretsBlock,
} from './hooks';
import {
  buildAntigravityAlwaysOnRule,
  globalAntigravityPromptSecretsRuleExists,
  PROMPT_SECRETS_BODY,
  PROMPT_SECRETS_RULE_DESCRIPTION,
  PROMPT_SECRETS_RULE_MARKER,
  SQAA_RULE_DESCRIPTION,
  SQAA_RULE_MARKER,
} from './rules';
import { scopedResource } from './scoped-resource';

export const ANTIGRAVITY_INTEGRATION_ID = 'antigravity';

export interface AntigravityIntegrationOptions extends IntegrateAgentOptions {
  projectRoot?: string;
  globalSecretsHookExists?: boolean;
  /** Install SQAA rules (project scope only). */
  installSqaaInstructions?: boolean;
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
      id: 'sqaa-instructions',
      displayName: 'SonarQube Agentic Analysis rules',
      shouldInstall: ({ options }) =>
        options.installSqaaInstructions === true ? askUser() : skip(),
      targetRoot: ({ options, targetRoot }) => options.projectRoot ?? targetRoot,
      scope: 'project',
      resources: [
        wholeFile({
          id: 'sqaa-rule-file',
          displayName: 'SonarQube Agentic Analysis rule for Antigravity',
          targetPath: resolveSqaaRulePath,
          content: (context) =>
            buildAntigravityAlwaysOnRule(
              SQAA_RULE_DESCRIPTION,
              buildSqaaSectionBody(
                getRequiredStringAttr(context, 'projectKey', antigravityIntegration.displayName),
              ),
            ),
          managedMarker: SQAA_RULE_MARKER,
        }),
      ],
      legacyCleanups: [
        wholeFileRemover({
          id: 'legacy-sqaa-instructions-file',
          targetPath: (context) =>
            join(context.targetRoot, ANTIGRAVITY_LEGACY_PROJECT_INSTRUCTIONS_PATH),
          managedMarker: SQAA_RULE_MARKER,
        }),
      ],
    },
    {
      id: 'mcp-server',
      displayName: 'MCP server',
      resources: [
        jsonPatch({
          id: 'antigravity-mcp-config',
          displayName: 'Antigravity MCP configuration',
          targetPath: () => ANTIGRAVITY_GLOBAL_MCP_CONFIG_JSON,
          defaultValue: {},
          patch: (document) =>
            upsertJsonMcpServer(document, getMcpConfig(CLI_COMMAND, { withFsMount: false })),
          removePatch: (document) => removeJsonMcpServer(document),
        }),
      ],
    },
    {
      id: 'prompt-secrets-instructions',
      displayName: 'Prompt-secrets rules',
      shouldInstall: ({ scope }) =>
        scope === 'project' && globalAntigravityPromptSecretsRuleExists()
          ? askUser(
              'Global Antigravity rules already exist. Do you also want to create a project-local copy for this repo?',
            )
          : askUser(),
      resources: [
        scopedResource(
          'project',
          wholeFile({
            id: 'prompt-secrets-rule-file',
            displayName: 'Antigravity prompt-secrets workspace rule',
            targetPath: resolvePromptSecretsRulePath,
            content: () =>
              buildAntigravityAlwaysOnRule(PROMPT_SECRETS_RULE_DESCRIPTION, PROMPT_SECRETS_BODY),
            managedMarker: PROMPT_SECRETS_RULE_MARKER,
          }),
        ),
        scopedResource(
          'global',
          textSnippet({
            id: 'prompt-secrets-gemini-snippet',
            displayName: 'Antigravity prompt-secrets global rules',
            targetPath: () => ANTIGRAVITY_GLOBAL_GEMINI_MD,
            startMarker: sonarBeginMarker('antigravity-prompt-secrets'),
            endMarker: sonarEndMarker('antigravity-prompt-secrets'),
            content: PROMPT_SECRETS_BODY,
          }),
        ),
      ],
      legacyCleanups: [
        wholeFileRemover({
          id: 'legacy-prompt-secrets-instructions-file',
          targetPath: (context) =>
            context.scope === 'project'
              ? join(context.targetRoot, ANTIGRAVITY_LEGACY_PROJECT_INSTRUCTIONS_PATH)
              : ANTIGRAVITY_LEGACY_GLOBAL_INSTRUCTIONS_PATH,
          managedMarker: PROMPT_SECRETS_RULE_MARKER,
        }),
      ],
    },
    createContextAugmentationFeature<AntigravityIntegrationOptions>({
      agentDisplayName: 'Antigravity',
      targetPath: resolveAntigravitySkillPath,
    }),
  ],
};

function resolvePromptSecretsRulePath(context: IntegrationContext): string {
  return join(
    context.targetRoot,
    ANTIGRAVITY_PROJECT_RULES_DIR,
    ANTIGRAVITY_PROMPT_SECRETS_RULE_FILE,
  );
}

function resolveSqaaRulePath(context: IntegrationContext): string {
  return join(context.targetRoot, ANTIGRAVITY_PROJECT_RULES_DIR, ANTIGRAVITY_SQAA_RULE_FILE);
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

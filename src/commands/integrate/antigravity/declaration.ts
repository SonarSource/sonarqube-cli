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
  ANTIGRAVITY_PROJECT_AGENTS_DIR,
  ANTIGRAVITY_PROJECT_RULES_DIR,
  ANTIGRAVITY_PROMPT_SECRETS_RULE_FILE,
  ANTIGRAVITY_SQAA_RULE_FILE,
  CLI_COMMAND,
} from '../../../lib/config-constants.ts';
import { getMcpConfig } from '../../../lib/mcp/mcp-helper.ts';
import { getRequiredStringAttr } from '../_common/attrs.ts';
import {
  AGENTIC_ANALYSIS_INSTRUCTIONS_FEATURE_BENEFIT,
  AGENTIC_ANALYSIS_INSTRUCTIONS_FEATURE_PREVIEW,
  MCP_SERVER_FEATURE_BENEFIT,
  MCP_SERVER_FEATURE_PREVIEW,
  SECRETS_PRE_TOOL_USE_FEATURE_BENEFIT,
  SECRETS_PRE_TOOL_USE_FEATURE_PREVIEW,
  SECRETS_PROMPT_FEATURE_BENEFIT,
  SECRETS_PROMPT_FEATURE_PREVIEW,
} from '../_common/feature-constants.ts';
import { createContextAugmentationFeature } from '../_common/features/context-augmentation-feature.ts';
import { secretsScanningExample } from '../_common/features/sonar-secrets-hooks-feature.ts';
import {
  buildSqaaSectionBody,
  sonarBeginMarker,
  sonarEndMarker,
} from '../_common/instructions-templates.ts';
import { removeJsonMcpServer, upsertJsonMcpServer } from '../_common/mcp-config.ts';
import type { IntegrationContext, IntegrationDeclaration } from '../_common/registry';
import {
  askUser,
  jsonPatch,
  skip,
  sonarSecretsBinaryDependency,
  textSnippet,
  textSnippetRemover,
  wholeFile,
} from '../_common/registry';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { getSecretPreToolTemplateUnix, getSecretPreToolTemplateWindows } from './hook-templates.ts';
import {
  removeAntigravitySecretsBlock,
  resolveAntigravityHooksJsonPath,
  resolvePretoolSecretsScriptPath,
  upsertAntigravitySecretsBlock,
} from './hooks.ts';
import {
  buildAntigravityAlwaysOnRule,
  globalAntigravityPromptSecretsRuleExists,
  PROMPT_SECRETS_BODY,
  PROMPT_SECRETS_RULE_MARKER,
  resolveLegacyGlobalInstructionsPath,
  resolveLegacyProjectInstructionsPath,
  SQAA_RULE_MARKER,
} from './rules.ts';

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
      displayName: 'secret scanning hooks',
      benefitDescription: SECRETS_PRE_TOOL_USE_FEATURE_BENEFIT,
      previewDescription: SECRETS_PRE_TOOL_USE_FEATURE_PREVIEW,
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
      displayName: 'Vortex agentic analysis rules',
      benefitDescription: AGENTIC_ANALYSIS_INSTRUCTIONS_FEATURE_BENEFIT,
      previewDescription: AGENTIC_ANALYSIS_INSTRUCTIONS_FEATURE_PREVIEW,
      shouldInstall: ({ options }) =>
        options.installSqaaInstructions === true ? askUser() : skip(),
      targetRoot: ({ options, targetRoot }) => options.projectRoot ?? targetRoot,
      scope: 'project',
      resources: [
        wholeFile({
          id: 'sqaa-rule-file',
          displayName: 'Vortex agentic analysis rule for Antigravity',
          targetPath: resolveSqaaRulePath,
          content: (context) =>
            buildAntigravityAlwaysOnRule(
              buildSqaaSectionBody(
                getRequiredStringAttr(context, 'projectKey', antigravityIntegration.displayName),
              ),
            ),
          managedMarker: SQAA_RULE_MARKER,
        }),
      ],
      legacyCleanups: [
        textSnippetRemover({
          id: 'legacy-sqaa-instructions-snippet',
          targetPath: (context) => resolveLegacyProjectInstructionsPath(context.targetRoot),
          startMarker: sonarBeginMarker('sonarqube-agentic-analysis-protocol'),
          endMarker: sonarEndMarker('sonarqube-agentic-analysis-protocol'),
        }),
      ],
    },
    {
      id: 'mcp-server',
      displayName: 'MCP server',
      benefitDescription: MCP_SERVER_FEATURE_BENEFIT,
      previewDescription: MCP_SERVER_FEATURE_PREVIEW,
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
      id: 'prompt-secrets-project-rules',
      displayName: 'prompt-secrets workspace rules',
      benefitDescription: SECRETS_PROMPT_FEATURE_BENEFIT,
      previewDescription: SECRETS_PROMPT_FEATURE_PREVIEW,
      shouldInstall: ({ scope }) => {
        if (scope !== 'project') {
          return skip();
        }
        return globalAntigravityPromptSecretsRuleExists()
          ? askUser(
              'Global Antigravity rules already exist. Do you also want to create a project-local copy for this repo?',
            )
          : askUser();
      },
      resources: [
        wholeFile({
          id: 'prompt-secrets-rule-file',
          displayName: 'Antigravity prompt-secrets workspace rule',
          targetPath: resolvePromptSecretsRulePath,
          content: () => buildAntigravityAlwaysOnRule(PROMPT_SECRETS_BODY),
          managedMarker: PROMPT_SECRETS_RULE_MARKER,
        }),
      ],
      legacyCleanups: [
        textSnippetRemover({
          id: 'legacy-prompt-secrets-project-instructions',
          targetPath: (context) => resolveLegacyProjectInstructionsPath(context.targetRoot),
          startMarker: sonarBeginMarker('antigravity-prompt-secrets'),
          endMarker: sonarEndMarker('antigravity-prompt-secrets'),
        }),
      ],
    },
    {
      id: 'prompt-secrets-global-rules',
      displayName: 'prompt-secrets global rules',
      benefitDescription: SECRETS_PROMPT_FEATURE_BENEFIT,
      previewDescription: SECRETS_PROMPT_FEATURE_PREVIEW,
      shouldInstall: ({ scope }) => (scope === 'global' ? askUser() : skip()),
      resources: [
        textSnippet({
          id: 'prompt-secrets-gemini-snippet',
          displayName: 'Antigravity prompt-secrets global rules',
          targetPath: () => ANTIGRAVITY_GLOBAL_GEMINI_MD,
          startMarker: sonarBeginMarker('antigravity-prompt-secrets'),
          endMarker: sonarEndMarker('antigravity-prompt-secrets'),
          content: PROMPT_SECRETS_BODY,
        }),
      ],
      legacyCleanups: [
        textSnippetRemover({
          id: 'legacy-prompt-secrets-global-instructions',
          targetPath: () => resolveLegacyGlobalInstructionsPath(),
          startMarker: sonarBeginMarker('antigravity-prompt-secrets'),
          endMarker: sonarEndMarker('antigravity-prompt-secrets'),
        }),
      ],
    },
    createContextAugmentationFeature<AntigravityIntegrationOptions>({
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

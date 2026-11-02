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
} from '@/core/config-constants.ts';
import type {
  IntegrationContext,
  IntegrationDeclaration,
  ResourceDeclaration,
} from '@/core/framework/features';
import {
  jsonPatch,
  textSnippet,
  textSnippetRemover,
  wholeFile,
  wholeFileRemover,
} from '@/core/framework/features';

import { createMcpServerFeature } from '../_common/features/mcp-server-feature.ts';
import { createSecretsDetectionFeature } from '../_common/features/secrets-detection-feature.ts';
import {
  createSqaaInstructionsRule,
  createSqaaInstructionsSnippet,
  createSqaaInstructionsSubfeature,
} from '../_common/features/sqaa-instructions-feature.ts';
import { buildUnixHookScript, buildWindowsHookScript } from '../_common/hooks.ts';
import { sonarBeginMarker, sonarEndMarker } from '../_common/instructions-templates.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { createVortexFeature } from '../_common/vortex.ts';
import {
  removeAntigravitySecretsBlock,
  resolveAntigravityHooksJsonPath,
  resolvePretoolSecretsScriptPath,
  upsertAntigravitySecretsBlock,
} from './hooks.ts';
import {
  buildAntigravityAlwaysOnRule,
  PROMPT_SECRETS_BODY,
  PROMPT_SECRETS_RULE_MARKER,
  resolveLegacyGlobalInstructionsPath,
  resolveLegacyProjectInstructionsPath,
} from './rules.ts';

export const ANTIGRAVITY_INTEGRATION_ID = 'antigravity';
const ANTIGRAVITY_DISPLAY_NAME = 'Antigravity';

export type AntigravityIntegrationOptions = IntegrateAgentOptions;

// Antigravity has no session start event, so it doesn't deliver Vortex Context atm.
// It also has no global rules directory, so project scope gets an always-on rule file
// while global scope gets a snippet in the user's shared `~/.gemini/GEMINI.md`.
// @see https://antigravity.google/docs/rules-workflows/#global-rules
const antigravityVortexFeature = createVortexFeature<AntigravityIntegrationOptions>(
  [
    createSqaaInstructionsSubfeature<AntigravityIntegrationOptions>(
      [createSqaaInstructionsRule(resolveSqaaRulePath, buildAntigravityAlwaysOnRule)],
      'project',
    ),
    createSqaaInstructionsSubfeature<AntigravityIntegrationOptions>(
      [createSqaaInstructionsSnippet(() => ANTIGRAVITY_GLOBAL_GEMINI_MD)],
      'global',
    ),
  ],
  resolveAntigravitySkillPath,
);

export const antigravityIntegration: IntegrationDeclaration<AntigravityIntegrationOptions> = {
  id: ANTIGRAVITY_INTEGRATION_ID,
  displayName: ANTIGRAVITY_DISPLAY_NAME,
  features: [
    createSecretsDetectionFeature<AntigravityIntegrationOptions>({
      resources: createAntigravitySecretsDetectionResources(),
      replacedIds: ['prompt-secrets-project-rules', 'prompt-secrets-global-rules'],
      legacyCleanups: [
        wholeFileRemover({
          id: 'legacy-prompt-secrets-project-rule',
          targetPath: resolvePromptSecretsRulePath,
          managedMarker: PROMPT_SECRETS_RULE_MARKER,
        }),
        textSnippetRemover({
          id: 'legacy-prompt-secrets-instructions',
          targetPath: (context) =>
            context.scope === 'global'
              ? resolveLegacyGlobalInstructionsPath()
              : resolveLegacyProjectInstructionsPath(context.targetRoot),
          startMarker: sonarBeginMarker('antigravity-prompt-secrets'),
          endMarker: sonarEndMarker('antigravity-prompt-secrets'),
        }),
      ],
    }),
    {
      ...antigravityVortexFeature,
      legacyCleanups: [
        ...(antigravityVortexFeature.legacyCleanups ?? []),
        textSnippetRemover({
          id: 'legacy-sqaa-instructions-snippet',
          targetPath: (context) => resolveLegacyProjectInstructionsPath(context.targetRoot),
          startMarker: sonarBeginMarker('sonarqube-agentic-analysis-protocol'),
          endMarker: sonarEndMarker('sonarqube-agentic-analysis-protocol'),
        }),
      ],
    },
    createMcpServerFeature<AntigravityIntegrationOptions>({
      resolveConfigPath: () => ANTIGRAVITY_GLOBAL_MCP_CONFIG_JSON,
      alwaysGlobal: true,
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

function createAntigravitySecretsDetectionResources(): ResourceDeclaration[] {
  return [
    wholeFile({
      id: 'pretool-secrets-script',
      displayName: 'Antigravity PreToolUse hook script',
      targetPath: resolvePretoolSecretsScriptPath,
      content: {
        unix: buildUnixHookScript('antigravity-pre-tool-use'),
        windows: buildWindowsHookScript('antigravity-pre-tool-use'),
      },
      executable: true,
    }),
    jsonPatch({
      id: 'secrets-hooks-config',
      displayName: 'Secrets hooks configuration',
      targetPath: resolveAntigravityHooksJsonPath,
      defaultValue: {},
      patch: (document, context) => upsertAntigravitySecretsBlock(document, context),
      removePatch: (document) => removeAntigravitySecretsBlock(document),
    }),
    textSnippet({
      id: 'prompt-secrets-gemini-snippet',
      displayName: 'Antigravity prompt-secrets global rules',
      targetPath: () => ANTIGRAVITY_GLOBAL_GEMINI_MD,
      startMarker: sonarBeginMarker('antigravity-prompt-secrets'),
      endMarker: sonarEndMarker('antigravity-prompt-secrets'),
      content: PROMPT_SECRETS_BODY,
    }),
  ];
}

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

import { CURSOR_CONFIG_DIR } from '@/core/config-constants.ts';
import type {
  IntegrationContext,
  IntegrationDeclaration,
  ResourceDeclaration,
} from '@/core/framework/features';
import { jsonPatch } from '@/core/framework/features';

import {
  createContextAugmentationSubfeature,
  SESSION_START_SCRIPT_REL,
  VORTEX_HOOK_MARKER,
} from '../_common/features/context-augmentation-feature.ts';
import { createMcpServerFeature } from '../_common/features/mcp-server-feature.ts';
import { createSecretsDetectionFeature } from '../_common/features/secrets-detection-feature.ts';
import {
  createSonarSecretsHooksResources,
  resolveAgentHooksConfigPath,
} from '../_common/features/sonar-secrets-hooks-feature.ts';
import {
  createSqaaInstructionsRule,
  createSqaaInstructionsSubfeature,
} from '../_common/features/sqaa-instructions-feature.ts';
import {
  buildUnixHookScript,
  buildWindowsHookScript,
  resolveAgentHookScriptPath,
} from '../_common/hooks.ts';
import type { IntegrateAgentOptions } from '../_common/types.ts';
import { createVortexFeature } from '../_common/vortex.ts';
import {
  buildCursorHookEntry,
  createCursorHooksWriter,
  removeCursorHooks,
  upsertCursorHooks,
} from './hooks.ts';
import { buildCursorAlwaysOnRule } from './rules.ts';

const HOOKS_JSON = 'hooks.json';
const MCP_JSON = 'mcp.json';
const PREREAD_SCRIPT_REL = 'sonar-secrets/build-scripts/before-read-file-secrets';
const PRETOOL_SCRIPT_REL = 'sonar-secrets/build-scripts/pre-tool-use-secrets';
const PROMPT_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';

export const CURSOR_INTEGRATION_ID = 'cursor';
export const CURSOR_HOOKS_CONFIG_RESOURCE_ID = 'cursor-hooks-config';

const RULES_DIR = 'rules';
const SQAA_RULE_FILE = 'sonar-agentic-analysis.mdc';
// Shared cross-tool skills directory. Cursor reads `.agents/skills` (same as
// Codex and Antigravity), so the CAG skill is written there rather than to a
// Cursor-specific `.cursor/skills` to avoid a duplicate skill of the same name.
const AGENTS_SKILLS_DIR = join('.agents', 'skills');
const CAG_SKILL_NAME = 'sonar-context-augmentation';

export type CursorIntegrationOptions = IntegrateAgentOptions;

function resolveCursorMcpConfigPath(context: IntegrationContext): string {
  return join(context.targetRoot, CURSOR_CONFIG_DIR, MCP_JSON);
}

function resolveCursorSqaaRulePath(context: IntegrationContext): string {
  // targetRoot is the project root for project scope and the home directory for global scope.
  return join(context.targetRoot, CURSOR_CONFIG_DIR, RULES_DIR, SQAA_RULE_FILE);
}

// Context Augmentation is delivered as a native, on-demand skill (the same
// rendered SKILL.md the other agents receive), written to the shared
// `.agents/skills` directory that Cursor auto-discovers — not an always-applied
// rule, and not a Cursor-private `.cursor/skills` copy that would duplicate the
// skill Codex/Antigravity already install there.
function resolveCursorCagSkillPath(context: IntegrationContext): string {
  return join(context.targetRoot, AGENTS_SKILLS_DIR, CAG_SKILL_NAME, 'SKILL.md');
}

function createSessionStartHookConfigResource(): ResourceDeclaration {
  return jsonPatch({
    id: CURSOR_HOOKS_CONFIG_RESOURCE_ID,
    displayName: 'Cursor session start hook configuration',
    targetPath: resolveCursorHooksJsonPath,
    defaultValue: { version: 1, hooks: {} },
    patch: (document, context) =>
      upsertCursorHooks(document, [
        buildCursorHookEntry(context, CURSOR_CONFIG_DIR, 'sessionStart', SESSION_START_SCRIPT_REL, {
          marker: VORTEX_HOOK_MARKER,
        }),
      ]),
    removePatch: (document) => removeCursorHooks(document, [VORTEX_HOOK_MARKER]),
  });
}

function resolveCursorHooksJsonPath(context: IntegrationContext): string {
  return resolveAgentHooksConfigPath(context, CURSOR_CONFIG_DIR, HOOKS_JSON);
}

export const cursorIntegration: IntegrationDeclaration<CursorIntegrationOptions> = {
  id: CURSOR_INTEGRATION_ID,
  displayName: 'Cursor',
  features: [
    createSecretsDetectionFeature<CursorIntegrationOptions>({
      resources: createCursorSecretsDetectionResources(),
    }),
    createVortexFeature<CursorIntegrationOptions>(
      [
        createSqaaInstructionsSubfeature([
          createSqaaInstructionsRule(resolveCursorSqaaRulePath, buildCursorAlwaysOnRule),
        ]),
        createContextAugmentationSubfeature<CursorIntegrationOptions>({
          agent: 'cursor',
          scriptPath: (context) =>
            resolveAgentHookScriptPath(context, CURSOR_CONFIG_DIR, SESSION_START_SCRIPT_REL),
          hookConfigResource: createSessionStartHookConfigResource(),
        }),
      ],
      resolveCursorCagSkillPath,
    ),
    createMcpServerFeature<CursorIntegrationOptions>({
      resolveConfigPath: resolveCursorMcpConfigPath,
    }),
  ],
};

function createCursorSecretsDetectionResources(): ResourceDeclaration[] {
  return createSonarSecretsHooksResources({
    configDir: CURSOR_CONFIG_DIR,
    hooksConfigFileName: HOOKS_JSON,
    scripts: [
      {
        id: 'preread-secrets-script',
        displayName: 'Cursor beforeReadFile hook script',
        scriptPath: PREREAD_SCRIPT_REL,
        content: {
          unix: buildUnixHookScript('cursor-pre-file-read'),
          windows: buildWindowsHookScript('cursor-pre-file-read'),
        },
      },
      {
        id: 'pretool-secrets-script',
        displayName: 'Cursor preToolUse hook script',
        scriptPath: PRETOOL_SCRIPT_REL,
        content: {
          unix: buildUnixHookScript('cursor-pre-tool-use'),
          windows: buildWindowsHookScript('cursor-pre-tool-use'),
        },
      },
      {
        id: 'prompt-secrets-script',
        displayName: 'Cursor beforeSubmitPrompt hook script',
        scriptPath: PROMPT_SCRIPT_REL,
        content: {
          unix: buildUnixHookScript('cursor-prompt-submit'),
          windows: buildWindowsHookScript('cursor-prompt-submit'),
        },
      },
    ],
    hookEntries: [
      { eventType: 'preToolUse', marker: 'sonar-secrets', scriptPath: PRETOOL_SCRIPT_REL },
      { eventType: 'beforeReadFile', marker: 'sonar-secrets', scriptPath: PREREAD_SCRIPT_REL },
      { eventType: 'beforeSubmitPrompt', marker: 'sonar-secrets', scriptPath: PROMPT_SCRIPT_REL },
    ],
    hookWriter: createCursorHooksWriter(),
  });
}

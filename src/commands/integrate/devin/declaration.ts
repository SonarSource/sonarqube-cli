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

import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  FeatureContainer,
  IntegrationContext,
  IntegrationDeclaration,
  ResourceDeclaration,
  SubfeatureDeclaration,
} from '@/core/framework/features';
import { jsonPatch, textSnippetRemover, wholeFile } from '@/core/framework/features';
import { isDevinAgentEnv } from '@/core/host/environment/agent-detector.ts';
import { resolveDevinConfigDir } from '@/core/host/environment/devin-config-dir.ts';

import { createAgentOnboardingFeature } from '../_common/features/agent-onboarding.ts';
import {
  createCompletionAnalysisHookSubfeature,
  STOP_SCRIPT_REL,
} from '../_common/features/completion-analysis-hook-feature.ts';
import {
  createContextAugmentationSubfeature,
  SESSION_START_SCRIPT_REL,
  VORTEX_HOOK_MARKER,
} from '../_common/features/context-augmentation-feature.ts';
import { createMcpServerFeature } from '../_common/features/mcp-server-feature.ts';
import { createSecretsDetectionFeature } from '../_common/features/secrets-detection-feature.ts';
import { createSonarSecretsHooksResources } from '../_common/features/sonar-secrets-hooks-feature.ts';
import {
  createSqaaInstructionsRemover,
  SQAA_HOOK_FEATURE_ID,
  SQAA_INSTRUCTIONS_SUBFEATURE_ID,
} from '../_common/features/sqaa-instructions-feature.ts';
import {
  buildUnixHookScript,
  buildWindowsHookScript,
  createAgentHookEntry,
  removeAgentHooks,
  resolveAgentHookCommand,
  resolveAgentHookScriptPath,
  upsertAgentHooks,
} from '../_common/hooks.ts';
import { sonarBeginMarker, sonarEndMarker } from '../_common/instructions-templates.ts';
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
const SUBAGENT_START_SCRIPT_REL = `${VORTEX_HOOK_MARKER}/build-scripts/subagent-start-vortex`;
const SUBAGENT_START_HOOK_MATCHER = '^run_subagent$';
const SESSION_START_HOOK_MATCHER = '';
const PRETOOL_SECRETS_SCRIPT_REL = 'sonar-secrets/build-scripts/pretool-secrets';
const PROMPT_SECRETS_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';
const SECRETS_HOOK_MARKER = 'sonar-secrets';
const READ_HOOK_MATCHER = '^read$';
const SECRETS_ON_READ_MARKER = 'devin-secrets-on-read';

const DEVIN_NATIVE_HOOKS = {
  PostToolUse: {
    path: POSTTOOL_SQAA_SCRIPT_REL,
    matcher: SQAA_HOOK_MATCHER,
    subcommand: 'devin-post-tool-use',
  },
  SessionStart: {
    path: SESSION_START_SCRIPT_REL,
    matcher: SESSION_START_HOOK_MATCHER,
    subcommand: 'agent-session-start --agent devin',
  },
  Stop: { path: STOP_SCRIPT_REL, matcher: undefined, subcommand: 'agent-stop --agent devin' },
};

/** Devin also loads Claude hooks. Defer only to a native hook with the equivalent active entry. */
export async function hasDevinNativeHook(event: keyof typeof DEVIN_NATIVE_HOOKS): Promise<boolean> {
  if (!isDevinAgentEnv()) return false;

  const targetRoot = resolveDevinConfigDir();
  const context = { targetRoot, scope: 'global' } as const;
  const { path, matcher, subcommand } = DEVIN_NATIVE_HOOKS[event];
  const command = resolveAgentHookCommand(context, '', path);
  try {
    const document = JSON.parse(await readFile(join(targetRoot, DEVIN_CONFIG_FILE), 'utf8')) as {
      disableAllHooks?: boolean;
      hooks?: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>;
    };
    if (document.disableAllHooks === true) return false;
    const registered = document.hooks?.[event]?.some(
      (entry) =>
        entry.matcher === matcher &&
        entry.hooks.some((hook) => hook.type === 'command' && hook.command === command),
    );
    if (!registered) return false;

    const script = resolveAgentHookScriptPath(context, '', path);
    const windows = process.platform === 'win32';
    await access(script, windows ? constants.R_OK : constants.X_OK);
    const expected = windows ? buildWindowsHookScript(subcommand) : buildUnixHookScript(subcommand);
    return (await readFile(script, 'utf8')).replaceAll('\r\n', '\n') === expected;
  } catch {
    return false;
  }
}

function resolveDevinMcpConfigPath(context: IntegrationContext): string {
  return join(resolveDevinConfigDir(context.targetRoot), DEVIN_MCP_CONFIG_FILE);
}

// Devin ignores a standalone global `hooks.v1.json`: global hooks live under `hooks` in `config.json`.
function resolveDevinConfigPath(context: IntegrationContext): string {
  return join(resolveDevinConfigDir(context.targetRoot), DEVIN_CONFIG_FILE);
}

function resolveDevinAgentsMdPath(context: IntegrationContext): string {
  return join(resolveDevinConfigDir(context.targetRoot), DEVIN_AGENTS_MD_FILE);
}

// The hook helpers need a context rooted at the Devin config dir, which is `%APPDATA%\devin` on Windows.
function devinHookContext(context: IntegrationContext): IntegrationContext {
  return { ...context, targetRoot: resolveDevinConfigDir(context.targetRoot) };
}

function createDevinSecretsDetectionResources(): ResourceDeclaration[] {
  return createSonarSecretsHooksResources({
    configDir: '',
    hooksConfigFileName: DEVIN_CONFIG_FILE,
    resolveContext: devinHookContext,
    scripts: [
      {
        id: 'pretool-secrets-script',
        displayName: 'Devin PreToolUse hook script',
        scriptPath: PRETOOL_SECRETS_SCRIPT_REL,
        content: {
          unix: buildUnixHookScript('devin-pre-tool-use'),
          windows: buildWindowsHookScript('devin-pre-tool-use'),
        },
      },
      {
        id: 'prompt-secrets-script',
        displayName: 'Devin UserPromptSubmit hook script',
        scriptPath: PROMPT_SECRETS_SCRIPT_REL,
        content: {
          unix: buildUnixHookScript('devin-prompt-submit'),
          windows: buildWindowsHookScript('devin-prompt-submit'),
        },
      },
    ],
    hookEntries: [
      {
        eventType: 'PreToolUse',
        matcher: READ_HOOK_MATCHER,
        marker: SECRETS_HOOK_MARKER,
        scriptPath: PRETOOL_SECRETS_SCRIPT_REL,
      },
      {
        eventType: 'UserPromptSubmit',
        matcher: '',
        marker: SECRETS_HOOK_MARKER,
        scriptPath: PROMPT_SECRETS_SCRIPT_REL,
      },
    ],
  });
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

function createCagSubagentScriptResource(): ResourceDeclaration {
  return wholeFile({
    id: 'subagent-start-vortex-script',
    displayName: 'Devin subagent hook script',
    targetPath: (context) =>
      resolveAgentHookScriptPath(devinHookContext(context), '', SUBAGENT_START_SCRIPT_REL),
    content: {
      unix: buildUnixHookScript('devin-subagent-start'),
      windows: buildWindowsHookScript('devin-subagent-start'),
    },
    executable: true,
  });
}

function createCagHookConfigResource(): ResourceDeclaration {
  return jsonPatch({
    id: 'devin-hooks-config',
    displayName: 'Devin Vortex Context hook configuration',
    targetPath: resolveDevinConfigPath,
    defaultValue: { hooks: {} },
    patch: (document, context) =>
      upsertAgentHooks(document, [
        createAgentHookEntry(
          devinHookContext(context),
          '',
          'SessionStart',
          SESSION_START_HOOK_MATCHER,
          VORTEX_HOOK_MARKER,
          SESSION_START_SCRIPT_REL,
        ),
        createAgentHookEntry(
          devinHookContext(context),
          '',
          'PreToolUse',
          SUBAGENT_START_HOOK_MATCHER,
          VORTEX_HOOK_MARKER,
          SUBAGENT_START_SCRIPT_REL,
        ),
      ]),
    removePatch: (document) => removeAgentHooks(document, [VORTEX_HOOK_MARKER]),
  });
}

function createDevinVortexFeature(): FeatureContainer<DevinIntegrationOptions> {
  const feature = createVortexFeature<DevinIntegrationOptions>([
    createSqaaHookSubfeature(),
    createCompletionAnalysisHookSubfeature<DevinIntegrationOptions>({
      agent: 'devin',
      configDir: '',
      settingsPath: resolveDevinConfigPath,
      resolveContext: devinHookContext,
    }),
    createContextAugmentationSubfeature<DevinIntegrationOptions>({
      agent: 'devin',
      scriptPath: (context) =>
        resolveAgentHookScriptPath(devinHookContext(context), '', SESSION_START_SCRIPT_REL),
      hookConfigResource: createCagHookConfigResource(),
      additionalResources: [createCagSubagentScriptResource()],
    }),
  ]);
  return {
    ...feature,
    replacedIds: [...(feature.replacedIds ?? []), SQAA_INSTRUCTIONS_SUBFEATURE_ID],
    legacyCleanups: [
      ...(feature.legacyCleanups ?? []),
      createSqaaInstructionsRemover(resolveDevinAgentsMdPath),
    ],
  };
}

export const devinIntegration: IntegrationDeclaration<DevinIntegrationOptions> = {
  id: DEVIN_INTEGRATION_ID,
  displayName: DEVIN_DISPLAY_NAME,
  features: [
    createAgentOnboardingFeature('devin'),
    createSecretsDetectionFeature<DevinIntegrationOptions>({
      resources: createDevinSecretsDetectionResources(),
      replacedIds: ['secrets-instructions'],
      legacyCleanups: [
        textSnippetRemover({
          id: 'devin-secrets-instructions',
          targetPath: resolveDevinAgentsMdPath,
          startMarker: sonarBeginMarker(SECRETS_ON_READ_MARKER),
          endMarker: sonarEndMarker(SECRETS_ON_READ_MARKER),
        }),
      ],
    }),
    createDevinVortexFeature(),
    createMcpServerFeature<DevinIntegrationOptions>({
      resolveConfigPath: resolveDevinMcpConfigPath,
      alwaysGlobal: true,
    }),
  ],
};

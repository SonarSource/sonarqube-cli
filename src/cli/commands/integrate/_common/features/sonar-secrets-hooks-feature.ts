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

import type { CliState, IntegrationScope } from '../../../../../lib/state';
import {
  createAgentHookEntry,
  removeAgentHooks,
  resolveAgentHookScriptPath,
  upsertAgentHooks,
} from '../hooks';
import { sonarSecretsBinaryDependency } from '../registry/dependencies';
import { isFeatureInstalledGloballyForProject } from '../registry/installation-recorder';
import { jsonPatch, type PlatformSpecificContent, wholeFile } from '../registry/resources';
import { askUser, skip } from '../registry/selection';
import type { FeatureDeclaration, IntegrationContext, PostInstallExample } from '../registry/types';

const SONAR_SECRETS_HOOKS_FEATURE_ID = 'sonar-secrets-hooks';

export interface SonarSecretsHooksFeatureOptions {
  globalSecretsHookExists?: boolean;
}

/** True when a global secrets hook already exists, per the explicit option or, when unset, the recorded state. */
function globalSecretsHookAlreadyConfigured(
  integrationId: string,
  options: SonarSecretsHooksFeatureOptions,
  scope: IntegrationScope,
  state: CliState,
): boolean {
  if (options.globalSecretsHookExists !== undefined) {
    return options.globalSecretsHookExists;
  }
  return isFeatureInstalledGloballyForProject(
    state,
    scope,
    integrationId,
    SONAR_SECRETS_HOOKS_FEATURE_ID,
  );
}

export function secretsScanningExample(agentDisplayName: string): PostInstallExample {
  return {
    intro: `See it in action — paste this into ${agentDisplayName}:`,
    lines: ['Can you push a commit using my token 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?'],
    footer: '  Sonar will detect the token and block the prompt automatically.',
  };
}

export interface SonarSecretsHookScriptSpec {
  id: string;
  displayName: string;
  scriptPath: string;
  content: PlatformSpecificContent;
}

export interface SonarSecretsHookEntrySpec {
  eventType: string;
  matcher: string;
  marker: string;
  scriptPath: string;
}

export interface SonarSecretsHooksFeatureConfig {
  agentDisplayName: string;
  integrationId: string;
  configDir: string;
  hooksConfigFileName: string;
  hooksPatchId: string;
  /** Hook scripts to install. Codex supplies only UserPromptSubmit; Claude adds PreToolUse. */
  scripts: SonarSecretsHookScriptSpec[];
  hookEntries: SonarSecretsHookEntrySpec[];
}

export function resolveAgentHooksConfigPath(
  context: IntegrationContext,
  configDir: string,
  fileName: string,
): string {
  return join(context.targetRoot, configDir, fileName);
}

export function createSonarSecretsHooksFeature<TOptions extends SonarSecretsHooksFeatureOptions>(
  config: SonarSecretsHooksFeatureConfig,
): FeatureDeclaration<TOptions> {
  const resolveHooksConfigPath = (context: IntegrationContext) =>
    resolveAgentHooksConfigPath(context, config.configDir, config.hooksConfigFileName);

  return {
    id: SONAR_SECRETS_HOOKS_FEATURE_ID,
    displayName: 'secret scanning hooks',
    shouldInstall: ({ options, scope, state }) =>
      globalSecretsHookAlreadyConfigured(config.integrationId, options, scope, state)
        ? skip(
            'A global secrets scanning hook is already configured. Skipping project-level secrets hooks to avoid duplicate execution.',
          )
        : askUser(),
    postInstallExample: secretsScanningExample(config.agentDisplayName),
    dependencies: [sonarSecretsBinaryDependency],
    resources: [
      ...config.scripts.map((script) =>
        wholeFile({
          id: script.id,
          displayName: script.displayName,
          targetPath: (context) =>
            resolveAgentHookScriptPath(context, config.configDir, script.scriptPath),
          content: script.content,
          executable: true,
        }),
      ),
      jsonPatch({
        id: config.hooksPatchId,
        displayName: `${config.agentDisplayName} hooks configuration`,
        targetPath: resolveHooksConfigPath,
        defaultValue: { hooks: {} },
        patch: (document, context) =>
          upsertAgentHooks(
            document,
            config.hookEntries.map((entry) =>
              createAgentHookEntry(
                context,
                config.configDir,
                entry.eventType,
                entry.matcher,
                entry.marker,
                entry.scriptPath,
              ),
            ),
          ),
        removePatch: (document) =>
          removeAgentHooks(
            document,
            config.hookEntries.map((entry) => entry.marker),
          ),
      }),
    ],
  };
}

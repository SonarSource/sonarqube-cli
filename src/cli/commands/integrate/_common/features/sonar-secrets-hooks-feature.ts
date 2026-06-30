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
import { SECRETS_FEATURE_DESCRIPTION } from '../feature-constants';
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
  featureId: string,
  options: SonarSecretsHooksFeatureOptions,
  scope: IntegrationScope,
  state: CliState,
): boolean {
  if (options.globalSecretsHookExists !== undefined) {
    return options.globalSecretsHookExists;
  }
  return isFeatureInstalledGloballyForProject(state, scope, integrationId, featureId);
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
  /** Event matcher (e.g. tool name or `*`). Used by the default Claude/Codex writer; ignored by writers whose schema has no matcher (e.g. Cursor). */
  matcher?: string;
  marker: string;
  scriptPath: string;
}

/**
 * Serializes hook entries into an agent's hook-config document. Claude and Codex share the default
 * writer (`{ hooks: { <event>: [{ matcher, hooks: [...] }] } }`); agents whose config uses a
 * different schema (e.g. Cursor's flat `{ command }` entries) inject their own.
 */
export interface SonarSecretsHooksWriter {
  defaultValue: unknown;
  patch: (
    document: unknown,
    context: IntegrationContext,
    entries: SonarSecretsHookEntrySpec[],
    configDir: string,
  ) => unknown;
  removePatch: (document: unknown, markers: string[]) => unknown;
}

/** Default writer: the nested `{ matcher, hooks: [{ type, command, timeout }] }` schema used by Claude and Codex. */
const agentHooksWriter: SonarSecretsHooksWriter = {
  defaultValue: { hooks: {} },
  patch: (document, context, entries, configDir) =>
    upsertAgentHooks(
      document,
      entries.map((entry) =>
        createAgentHookEntry(
          context,
          configDir,
          entry.eventType,
          entry.matcher ?? '*',
          entry.marker,
          entry.scriptPath,
        ),
      ),
    ),
  removePatch: (document, markers) => removeAgentHooks(document, markers),
};

export interface SonarSecretsHooksFeatureConfig {
  agentDisplayName: string;
  integrationId: string;
  configDir: string;
  hooksConfigFileName: string;
  hooksPatchId: string;
  /** Hook scripts to install. Codex supplies only UserPromptSubmit; Claude adds PreToolUse. */
  scripts: SonarSecretsHookScriptSpec[];
  hookEntries: SonarSecretsHookEntrySpec[];
  /** Feature id recorded in state. Defaults to the shared `sonar-secrets-hooks`. */
  featureId?: string;
  /** Feature display name shown during install. Defaults to `secret scanning hooks`. */
  displayName?: string;
  /** Hook-config serializer. Defaults to the Claude/Codex schema; agents like Cursor inject their own. */
  hookWriter?: SonarSecretsHooksWriter;
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
  const featureId = config.featureId ?? SONAR_SECRETS_HOOKS_FEATURE_ID;
  const writer = config.hookWriter ?? agentHooksWriter;
  const resolveHooksConfigPath = (context: IntegrationContext) =>
    resolveAgentHooksConfigPath(context, config.configDir, config.hooksConfigFileName);

  return {
    id: featureId,
    displayName: config.displayName ?? 'secret scanning hooks',
    benefitDescription: SECRETS_FEATURE_DESCRIPTION,
    shouldInstall: ({ options, scope, state }) =>
      globalSecretsHookAlreadyConfigured(config.integrationId, featureId, options, scope, state)
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
        defaultValue: writer.defaultValue,
        patch: (document, context) =>
          writer.patch(document, context, config.hookEntries, config.configDir),
        removePatch: (document) =>
          writer.removePatch(
            document,
            config.hookEntries.map((entry) => entry.marker),
          ),
      }),
    ],
  };
}

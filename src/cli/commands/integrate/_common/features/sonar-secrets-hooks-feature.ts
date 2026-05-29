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

import { createAgentHookEntry, resolveAgentHookScriptPath, upsertAgentHooks } from '../hooks';
import { sonarSecretsBinaryDependency } from '../registry/dependencies';
import { isFeatureInstalled } from '../registry/installer';
import { jsonPatch, type PlatformSpecificContent, wholeFile } from '../registry/resources';
import type { FeatureDeclaration, IntegrationContext } from '../registry/types';

const SONAR_SECRETS_HOOKS_FEATURE_ID = 'sonar-secrets-hooks';
const SONAR_SECRETS_HOOKS_HINT =
  'scans prompts and file reads for secrets before they reach the agent';

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
  integrationId: string;
  agentDisplayName: string;
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

export function createSonarSecretsHooksFeature<TOptions>(
  config: SonarSecretsHooksFeatureConfig,
): FeatureDeclaration<TOptions> {
  const resolveHooksConfigPath = (context: IntegrationContext) =>
    resolveAgentHooksConfigPath(context, config.configDir, config.hooksConfigFileName);

  return {
    id: SONAR_SECRETS_HOOKS_FEATURE_ID,
    displayName: 'secrets hooks',
    hint: SONAR_SECRETS_HOOKS_HINT,
    // Skip project-level install when a global secrets hook already covers it; otherwise ask.
    when: ({ scope, state }) =>
      scope === 'project' &&
      isFeatureInstalled(state, config.integrationId, SONAR_SECRETS_HOOKS_FEATURE_ID, 'global')
        ? { kind: 'skip', reason: 'global hook already covers this' }
        : { kind: 'ask' },
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
      }),
    ],
  };
}

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
  createAgentHookEntry,
  resolveAgentHookScriptPath,
  upsertAgentHooks,
} from '../_common/hooks';
import {
  type IntegrationContext,
  type IntegrationDeclaration,
  jsonPatch,
  SonarSourceBinary,
  sonarSourceBinary,
  supportedIntegrations,
  wholeFile,
} from '../_common/registry';
import type { IntegrateAgentOptions } from '../_common/types';
import { getSecretPromptTemplateUnix, getSecretPromptTemplateWindows } from './hook-templates';

const CODEX_CONFIG_DIR = '.codex';
const HOOKS_FILE = 'hooks.json';
const PROMPT_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';

export const CODEX_INTEGRATION_ID = 'codex';

export interface CodexIntegrationOptions extends IntegrateAgentOptions {
  installBinary?: boolean;
  installSecretsHooks?: boolean;
}

export const codexIntegration: IntegrationDeclaration<CodexIntegrationOptions> = {
  id: CODEX_INTEGRATION_ID,
  displayName: 'Codex',
  features: [
    {
      id: 'sonar-secrets-binary',
      displayName: 'sonar-secrets binary',
      when: ({ options }) => options.installBinary === true,
      resources: [
        sonarSourceBinary({
          id: 'sonar-secrets',
          displayName: 'sonar-secrets binary',
          binary: SonarSourceBinary.SonarSecrets,
        }),
      ],
    },
    {
      id: 'sonar-secrets-hooks',
      displayName: 'secrets hooks',
      when: ({ options }) => options.installSecretsHooks === true,
      resources: [
        wholeFile({
          id: 'prompt-secrets-script',
          displayName: 'Codex UserPromptSubmit hook script',
          targetPath: (context) =>
            resolveAgentHookScriptPath(context, CODEX_CONFIG_DIR, PROMPT_SCRIPT_REL),
          content: {
            unix: getSecretPromptTemplateUnix(),
            windows: getSecretPromptTemplateWindows(),
          },
          executable: true,
        }),
        jsonPatch({
          id: 'codex-hooks-secrets-hook',
          displayName: 'Codex hooks configuration',
          targetPath: resolveCodexHooksFilePath,
          defaultValue: { hooks: {} },
          patch: (document, context) =>
            upsertAgentHooks(document, [
              createAgentHookEntry(
                context,
                CODEX_CONFIG_DIR,
                'UserPromptSubmit',
                '*',
                'sonar-secrets',
                PROMPT_SCRIPT_REL,
              ),
            ]),
        }),
      ],
    },
  ],
};

let codexIntegrationRegistered = false;

export function registerCodexIntegration(): void {
  if (codexIntegrationRegistered) {
    return;
  }

  supportedIntegrations.register(codexIntegration);
  codexIntegrationRegistered = true;
}

function resolveCodexHooksFilePath(context: IntegrationContext): string {
  return join(context.targetRoot, CODEX_CONFIG_DIR, HOOKS_FILE);
}

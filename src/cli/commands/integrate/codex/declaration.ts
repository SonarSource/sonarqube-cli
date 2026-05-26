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

import { createSonarSecretsBinaryFeature } from '../_common/features/sonar-secrets-binary-feature';
import { createSonarSecretsHooksFeature } from '../_common/features/sonar-secrets-hooks-feature';
import {
  type IntegrationContext,
  type IntegrationDeclaration,
  supportedIntegrations,
  wholeFile,
} from '../_common/registry';
import type { IntegrateAgentOptions } from '../_common/types';
import { getSecretPromptTemplateUnix, getSecretPromptTemplateWindows } from './hook-templates';
import { buildAgentsMdContent } from './instructions-templates';

const CODEX_CONFIG_DIR = '.codex';
const HOOKS_FILE = 'hooks.json';
const AGENTS_MD_FILE = 'AGENTS.md';
const PROMPT_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';

export const CODEX_INTEGRATION_ID = 'codex';

export interface CodexIntegrationOptions extends IntegrateAgentOptions {
  installBinary?: boolean;
  installSecretsHooks?: boolean;
  /** Render the pre-tool secrets-on-read section into `.codex/AGENTS.md`. */
  installSecretsInstructions?: boolean;
  /** Render the post-tool SQAA section into `.codex/AGENTS.md`. */
  installSqaaInstructions?: boolean;
}

export const codexIntegration: IntegrationDeclaration<CodexIntegrationOptions> = {
  id: CODEX_INTEGRATION_ID,
  displayName: 'Codex',
  features: [
    createSonarSecretsBinaryFeature(),
    createSonarSecretsHooksFeature({
      agentDisplayName: 'Codex',
      configDir: CODEX_CONFIG_DIR,
      hooksConfigFileName: HOOKS_FILE,
      hooksPatchId: 'codex-hooks-secrets-hook',
      scripts: [
        {
          id: 'prompt-secrets-script',
          displayName: 'Codex UserPromptSubmit hook script',
          scriptPath: PROMPT_SCRIPT_REL,
          content: {
            unix: getSecretPromptTemplateUnix(),
            windows: getSecretPromptTemplateWindows(),
          },
        },
      ],
      hookEntries: [
        {
          eventType: 'UserPromptSubmit',
          matcher: '*',
          marker: 'sonar-secrets',
          scriptPath: PROMPT_SCRIPT_REL,
        },
      ],
    }),
    {
      id: 'agents-md-instructions',
      displayName: 'Codex AGENTS.md instructions',
      // Fires whenever at least one section is enabled. Each section's
      // inclusion is then decided from attrs by the content function, so the
      // two flags act as independent toggles even though both sections share
      // a single file.
      when: ({ options }) =>
        options.installSecretsInstructions === true || options.installSqaaInstructions === true,
      resources: [
        wholeFile({
          id: 'codex-agents-md',
          displayName: 'Codex AGENTS.md',
          targetPath: resolveCodexAgentsMdPath,
          content: (context) =>
            buildAgentsMdContent({
              includeSecrets: getOptionalBoolAttr(context, 'includeSecretsSection'),
              projectKey: getOptionalStringAttr(context, 'projectKey'),
            }),
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

function resolveCodexAgentsMdPath(context: IntegrationContext): string {
  return join(context.targetRoot, CODEX_CONFIG_DIR, AGENTS_MD_FILE);
}

function getOptionalStringAttr(context: IntegrationContext, key: string): string | undefined {
  const value = context.attrs?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getOptionalBoolAttr(context: IntegrationContext, key: string): boolean {
  return context.attrs?.[key] === true;
}

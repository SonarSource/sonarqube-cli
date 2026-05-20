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
const HOOKS_DIR = 'hooks';
const HOOKS_FILE = 'hooks.json';
const HOOK_TIMEOUT_SEC = 60;
const PROMPT_SCRIPT_REL = 'sonar-secrets/build-scripts/prompt-secrets';

export const CODEX_INTEGRATION_ID = 'codex';

export interface CodexIntegrationOptions extends IntegrateAgentOptions {
  installBinary?: boolean;
  installSecretsHooks?: boolean;
}

interface HookCommand {
  type: 'command';
  command: string;
  timeout: number;
}

interface HookConfig {
  matcher: string;
  hooks: HookCommand[];
}

interface CodexHooksFile {
  hooks?: Record<string, HookConfig[] | undefined>;
  [key: string]: unknown;
}

interface ManagedCodexHookEntry {
  eventType: string;
  marker: string;
  hookConfig: HookConfig;
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
          targetPath: (context) => resolveCodexHookScriptPath(context, PROMPT_SCRIPT_REL),
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
            upsertCodexHooks(document, [
              createCodexHookEntry(
                context,
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

function resolveCodexHookScriptPath(context: IntegrationContext, scriptPath: string): string {
  const extension = process.platform === 'win32' ? '.ps1' : '.sh';
  return join(context.targetRoot, CODEX_CONFIG_DIR, HOOKS_DIR, `${scriptPath}${extension}`);
}

function resolveCodexHooksFilePath(context: IntegrationContext): string {
  return join(context.targetRoot, CODEX_CONFIG_DIR, HOOKS_FILE);
}

function createCodexHookEntry(
  context: IntegrationContext,
  eventType: string,
  matcher: string,
  marker: string,
  scriptPath: string,
): ManagedCodexHookEntry {
  return {
    eventType,
    marker,
    hookConfig: {
      matcher,
      hooks: [
        {
          type: 'command',
          command: resolveCodexHookCommand(context, scriptPath),
          timeout: HOOK_TIMEOUT_SEC,
        },
      ],
    },
  };
}

function resolveCodexHookCommand(context: IntegrationContext, scriptPath: string): string {
  const extension = process.platform === 'win32' ? '.ps1' : '.sh';
  const relativePath = join(CODEX_CONFIG_DIR, HOOKS_DIR, `${scriptPath}${extension}`);
  const commandPath =
    context.scope === 'global' ? join(context.targetRoot, relativePath) : relativePath;

  return process.platform === 'win32'
    ? `powershell -NoProfile -File ${commandPath.replaceAll('\\', '/')}`
    : commandPath;
}

function upsertCodexHooks(document: unknown, entries: ManagedCodexHookEntry[]): CodexHooksFile {
  const settings = toCodexHooksFile(document);
  settings.hooks ??= {};

  for (const entry of entries) {
    const existingEntries = settings.hooks[entry.eventType] ?? [];
    settings.hooks[entry.eventType] = [
      ...existingEntries.filter((hook) => !ownsCodexHookEntry(hook, entry.marker)),
      entry.hookConfig,
    ];
  }

  return settings;
}

function ownsCodexHookEntry(entry: HookConfig, marker: string): boolean {
  return entry.hooks.some((hook) => hook.command.includes(marker));
}

function toCodexHooksFile(document: unknown): CodexHooksFile {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { hooks: {} };
  }

  const settings = document as CodexHooksFile;
  return {
    ...settings,
    hooks: settings.hooks ? { ...settings.hooks } : {},
  };
}

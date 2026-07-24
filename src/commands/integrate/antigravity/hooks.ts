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

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  ANTIGRAVITY_GLOBAL_HOOKS_JSON,
  ANTIGRAVITY_GLOBAL_SONAR_HOOKS_DIR,
  ANTIGRAVITY_PROJECT_HOOKS_JSON,
  ANTIGRAVITY_PROJECT_SONAR_HOOKS_DIR,
  ANTIGRAVITY_PROJECT_SONAR_HOOKS_DIR_FROM_AGENTS,
} from '@/core/config-constants.ts';
import { warn } from '@/core/ui';

import { HOOK_TIMEOUT_SEC, readOrInitJson, SONAR_SECRETS_MARKER } from '../_common/hooks.ts';
import type { IntegrationContext } from '../_common/registry';

export const SONAR_SECRETS_BLOCK_NAME = 'sonar-secrets';
export const PRETOOL_SECRETS_BASENAME = 'pretool-secrets';
export const VIEW_FILE_MATCHER = 'view_file';
export const ANTIGRAVITY_PRE_TOOL_HOOK_MARKER = 'antigravity-pre-tool-use';

export interface AntigravityHookCommand {
  type?: 'command';
  command: string;
  timeout?: number;
}

export interface AntigravityToolHookEntry {
  matcher: string;
  hooks: AntigravityHookCommand[];
}

export interface AntigravityFlatHookEntry {
  type?: 'command';
  command: string;
  timeout?: number;
}

export interface AntigravityHookBlock {
  enabled?: boolean;
  PreToolUse?: AntigravityToolHookEntry[];
  PostInvocation?: AntigravityFlatHookEntry[];
}

export type AntigravityHooksDocument = Record<string, AntigravityHookBlock | undefined>;

/**
 * Probe `~/.gemini/config/hooks.json` for an existing global sonar-secrets
 * PreToolUse hook. Returns the active hook script path when healthy, so project
 * installs can skip duplicate secrets scanning.
 */
export async function detectGlobalSecretsHook(): Promise<string | undefined> {
  if (!existsSync(ANTIGRAVITY_GLOBAL_HOOKS_JSON)) return undefined;

  const parsed = await readOrInitJson<AntigravityHooksDocument>(ANTIGRAVITY_GLOBAL_HOOKS_JSON, {});
  const block = parsed[SONAR_SECRETS_BLOCK_NAME];
  if (block?.enabled === false) return undefined;
  const matchedEntry = block?.PreToolUse?.find(isSonarSecretsPreToolUseEntry);
  if (!matchedEntry) return undefined;

  const command = matchedEntry.hooks.find((hook) =>
    hookReferencesSonarSecrets(hook.command),
  )?.command;
  const scriptPath =
    (command ? extractScriptPathFromHookCommand(command) : undefined) ??
    join(ANTIGRAVITY_GLOBAL_SONAR_HOOKS_DIR, hookScriptName());
  if (!existsSync(scriptPath)) {
    warn(
      `Global hook configuration detected at ${ANTIGRAVITY_GLOBAL_HOOKS_JSON} but the backing script is missing. Falling back to project-level installation.`,
    );
    return undefined;
  }

  return scriptPath;
}

export function upsertAntigravitySecretsBlock(
  document: unknown,
  context: IntegrationContext,
): AntigravityHooksDocument {
  const doc = toAntigravityHooksDocument(document);
  const command = formatAntigravityHookCommand(resolveAntigravityHookCommandPath(context));
  const existingBlock = doc[SONAR_SECRETS_BLOCK_NAME];

  const preToolUseEntry: AntigravityToolHookEntry = {
    matcher: VIEW_FILE_MATCHER,
    hooks: [
      {
        type: 'command',
        command,
        timeout: HOOK_TIMEOUT_SEC,
      },
    ],
  };

  const preservedPreToolUse =
    existingBlock?.PreToolUse?.filter((entry) => !isSonarSecretsPreToolUseEntry(entry)) ?? [];

  doc[SONAR_SECRETS_BLOCK_NAME] = {
    enabled: true,
    PreToolUse: [...preservedPreToolUse, preToolUseEntry],
    ...(existingBlock?.PostInvocation ? { PostInvocation: existingBlock.PostInvocation } : {}),
  };

  return doc;
}

export function removeAntigravitySecretsBlock(document: unknown): AntigravityHooksDocument {
  const doc = toAntigravityHooksDocument(document);
  const block = doc[SONAR_SECRETS_BLOCK_NAME];
  if (!block) return doc;

  const preToolUse =
    block.PreToolUse?.filter((entry) => !isSonarSecretsPreToolUseEntry(entry)) ?? [];
  const hasPostInvocation = (block.PostInvocation?.length ?? 0) > 0;

  if (preToolUse.length === 0 && !hasPostInvocation) {
    const { [SONAR_SECRETS_BLOCK_NAME]: _removed, ...rest } = doc;
    return rest;
  }

  const nextBlock: AntigravityHookBlock = { ...block };
  if (preToolUse.length > 0) {
    nextBlock.PreToolUse = preToolUse;
  } else {
    delete nextBlock.PreToolUse;
  }

  doc[SONAR_SECRETS_BLOCK_NAME] = nextBlock;
  return doc;
}

export function resolveAntigravityHooksJsonPathForScope(
  scope: 'project' | 'global',
  targetRoot: string,
): string {
  return scope === 'global'
    ? ANTIGRAVITY_GLOBAL_HOOKS_JSON
    : join(targetRoot, ANTIGRAVITY_PROJECT_HOOKS_JSON);
}

export function resolveAntigravityHooksJsonPath(context: IntegrationContext): string {
  return resolveAntigravityHooksJsonPathForScope(context.scope, context.targetRoot);
}

export function resolvePretoolSecretsScriptPath(context: IntegrationContext): string {
  const hooksDir =
    context.scope === 'global'
      ? ANTIGRAVITY_GLOBAL_SONAR_HOOKS_DIR
      : join(context.targetRoot, ANTIGRAVITY_PROJECT_SONAR_HOOKS_DIR);
  return join(hooksDir, hookScriptName());
}

export function resolveAntigravityHookCommandPath(context: IntegrationContext): string {
  if (context.scope === 'global') {
    return resolvePretoolSecretsScriptPath(context);
  }
  // hooks.json lives under .agents/; Antigravity invokes PreToolUse commands with cwd=.agents/
  return join(ANTIGRAVITY_PROJECT_SONAR_HOOKS_DIR_FROM_AGENTS, hookScriptName());
}

export function formatAntigravityHookCommand(scriptPath: string): string {
  const normalized = scriptPath.replaceAll('\\', '/');
  return process.platform === 'win32'
    ? `powershell -NoProfile -File "${normalized}"`
    : `bash "${normalized}"`;
}

/** Parse a hook shell command and return the script path. */
export function extractScriptPathFromHookCommand(command: string): string | undefined {
  const trimmed = command.trim();
  if (process.platform === 'win32') {
    return /^powershell -NoProfile -File "?([^"]+)"?$/i.exec(trimmed)?.[1];
  }
  return /^bash "?([^"]+)"?$/.exec(trimmed)?.[1];
}

export function hookScriptName(): string {
  return `${PRETOOL_SECRETS_BASENAME}${process.platform === 'win32' ? '.ps1' : '.sh'}`;
}

export function isSonarSecretsPreToolUseEntry(entry: AntigravityToolHookEntry): boolean {
  if (entry.matcher !== VIEW_FILE_MATCHER) return false;
  return entry.hooks.some((hook) => hookReferencesSonarSecrets(hook.command));
}

export function hookReferencesSonarSecrets(command: string): boolean {
  return (
    command.includes(ANTIGRAVITY_PRE_TOOL_HOOK_MARKER) ||
    command.includes(SONAR_SECRETS_MARKER) ||
    command.includes(PRETOOL_SECRETS_BASENAME) ||
    command.includes(hookScriptName())
  );
}

export function toAntigravityHooksDocument(document: unknown): AntigravityHooksDocument {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return {};
  }
  return { ...(document as AntigravityHooksDocument) };
}

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

// Shared hook helpers used by both the Claude and Copilot integrations.
// Keeps the hook script builders, the cross-platform script writer, and the
// JSON config read-or-init helper in one place so the two integrations stay
// behaviorally aligned.

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { IntegrationContext } from '@/core/framework/features';

import type { HookConfig, HooksDocument, ManagedHookEntry } from './types.ts';

export const SONAR_SECRETS_MARKER = 'sonar-secrets';

export const UNIX_SONAR_COMMAND_GUARD = `if ! command -v sonar &> /dev/null; then
  exit 0
fi`;

export const WINDOWS_SONAR_COMMAND_GUARD = `if (-not (Get-Command sonar -ErrorAction SilentlyContinue)) {
    exit 0
}`;

export function buildUnixHookScript(subcommand: string): string {
  return `#!/bin/bash\n${UNIX_SONAR_COMMAND_GUARD}\n${sonarHookCommand(subcommand)}\n`;
}

export function buildWindowsHookScript(subcommand: string): string {
  return `${WINDOWS_SONAR_COMMAND_GUARD}\n$stdinData = [Console]::In.ReadToEnd()\n$stdinData | & ${sonarHookCommand(subcommand)}\nexit $LASTEXITCODE\n`;
}

function sonarHookCommand(subcommand: string): string {
  return `sonar hook ${subcommand}`;
}

/**
 * Write a hook script for the current platform (`.sh` on Unix, `.ps1` on
 * Windows), creating `scriptDir` if needed. Returns the absolute path of
 * the script that was written.
 */
export async function writeHookScript(
  scriptDir: string,
  basename: string,
  unixContent: string,
  windowsContent: string,
): Promise<string> {
  const isWindows = process.platform === 'win32';
  const ext = isWindows ? '.ps1' : '.sh';
  const scriptPath = join(scriptDir, `${basename}${ext}`);
  mkdirSync(scriptDir, { recursive: true });
  await writeFile(
    scriptPath,
    isWindows ? windowsContent : unixContent,
    isWindows ? undefined : { mode: 0o755 },
  );
  return scriptPath;
}

/**
 * Read a JSON file at `path`, returning `defaultValue` when the file does
 * not exist or cannot be parsed. Used for hook config files that may be
 * missing or corrupted on a fresh install.
 */
export async function readOrInitJson<T>(path: string, defaultValue: T): Promise<T> {
  if (!existsSync(path)) return defaultValue;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return defaultValue;
  }
}

// ---------------------------------------------------------------------------
// Shared declarative-registry helpers
//
// The Claude and Codex integrations both store their hooks in a JSON document
// shaped like `{ hooks: { <eventType>: HookConfig[] } }` (Claude uses
// `.claude/settings.json`, Codex uses `.codex/hooks.json`). The helpers below
// drive the resource declarations in their `declaration.ts` files; only the
// per-agent config directory differs.
// ---------------------------------------------------------------------------

export const HOOK_TIMEOUT_SEC = 60;
export const HOOKS_DIR = 'hooks';

/** SonarQube project keys allowed when using a key into a generated hook shell script. */
export const SONAR_PROJECT_KEY_SAFE_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/**
 * Reject project keys that cannot be safely embedded in hook scripts (command
 * substitution, quotes, spaces, etc.).
 */
export function assertSafeSonarProjectKeyForHookScript(projectKey: string): void {
  if (!SONAR_PROJECT_KEY_SAFE_PATTERN.test(projectKey)) {
    throw new Error(
      `SonarQube project key "${projectKey}" cannot be embedded in a hook script. Use only letters, digits, and _ . : -`,
    );
  }
}

/** Bash idiom to embed `'` inside a single-quoted string: close `'`, add `'`, reopen `'`. */
const BASH_EMBEDDED_SINGLE_QUOTE = String.raw`'\''`;

/** Single-quoted Bash literal: no expansion of $, `, or command substitution. */
export function shellQuoteBash(value: string): string {
  return "'" + value.replaceAll("'", BASH_EMBEDDED_SINGLE_QUOTE) + "'";
}

/**
 * Double-quoted Bash literal that still allows `$var`/`${var}` expansion, unlike
 * {@link shellQuoteBash}. Needed when `value` embeds an agent-substituted placeholder (e.g.
 * Claude Code's `${CLAUDE_PROJECT_DIR}`) that must still expand — single-quoting it would leave
 * the literal, unexpanded token in the path. Only escapes what remains meaningful inside double
 * quotes (`\`, `"`, `` ` ``); `$` is left alone on purpose.
 */
export function shellDoubleQuoteBash(value: string): string {
  const escaped = value.replaceAll(/[\\"`]/g, String.raw`\$&`);
  return `"${escaped}"`;
}

/**
 * Quote a path for PowerShell's `-File` argument on Windows so it stays a single
 * argument when it contains **spaces**. Double quotes are used because Windows
 * paths cannot contain `"` (so no escaping is needed) and both cmd.exe and
 * PowerShell honor them.
 *
 * The guarantee is space-safety only. It does NOT neutralize shell-level
 * expansion of a path segment literally named e.g. `%TEMP%`: when the agent
 * launches the stored command through cmd.exe, cmd expands `%VAR%` even inside
 * double quotes, and no argument-level quoting (single or double) prevents that.
 * Such directory names are rare, and this mirrors the pre-existing behavior.
 */
export function quoteWindowsHookScriptPath(path: string): string {
  return `"${path}"`;
}

/** Absolute path to the platform-specific hook script under `<targetRoot>/<configDir>/hooks/`. */
export function resolveAgentHookScriptPath(
  context: IntegrationContext,
  configDir: string,
  scriptPath: string,
): string {
  const extension = process.platform === 'win32' ? '.ps1' : '.sh';
  return join(context.targetRoot, configDir, HOOKS_DIR, `${scriptPath}${extension}`);
}

function resolveHookCommandPath(
  context: IntegrationContext,
  relativePath: string,
  projectDirPlaceholder?: string,
): string {
  if (context.scope === 'global') {
    return join(context.targetRoot, relativePath);
  }
  if (projectDirPlaceholder) {
    return `${projectDirPlaceholder}/${relativePath.replaceAll('\\', '/')}`;
  }
  return relativePath;
}

/**
 * Hook `command` string: `powershell -NoProfile -ExecutionPolicy Bypass -File "<path>"` on
 * Windows, quoted path on Unix. The path is quoted so it stays a single
 * argument when the agent runs the command through a shell, even when the
 * project root or `$HOME` contains spaces or (on Unix) other shell
 * metacharacters (`$`, backticks, apostrophes, globs). Absolute path for global
 * scope. For project scope, `projectDirPlaceholder` (e.g. Claude Code's
 * `${CLAUDE_PROJECT_DIR}`) anchors the path to the agent's own project-root
 * variable instead of the process cwd, so the hook still resolves when cwd
 * diverges from the project root (worktrees, cwd changes); omit it for agents
 * with no such placeholder, which keeps the plain cwd-relative path.
 *
 * Windows already double-quotes unconditionally, which lets `${CLAUDE_PROJECT_DIR}` expand.
 * On Unix, a path using the placeholder is double-quoted too (`shellDoubleQuoteBash`) for the
 * same reason — single-quoting it (Bash's usual, stricter default) would leave the literal,
 * unexpanded token in the path instead of the real project root. Every other Unix path (global
 * scope, or project scope with no placeholder) keeps the stricter single-quoting.
 */
export function resolveAgentHookCommand(
  context: IntegrationContext,
  configDir: string,
  scriptPath: string,
  projectDirPlaceholder?: string,
): string {
  const extension = process.platform === 'win32' ? '.ps1' : '.sh';
  const relativePath = join(configDir, HOOKS_DIR, `${scriptPath}${extension}`);
  const commandPath = resolveHookCommandPath(context, relativePath, projectDirPlaceholder);

  if (process.platform === 'win32') {
    return `powershell -NoProfile -ExecutionPolicy Bypass -File ${quoteWindowsHookScriptPath(commandPath.replaceAll('\\', '/'))}`;
  }
  const usesPlaceholder = context.scope !== 'global' && Boolean(projectDirPlaceholder);
  return usesPlaceholder ? shellDoubleQuoteBash(commandPath) : shellQuoteBash(commandPath);
}

export interface AgentHookEntryOptions {
  /** e.g. Claude Code's `${CLAUDE_PROJECT_DIR}`; see {@link resolveAgentHookCommand}. */
  projectDirPlaceholder?: string;
  timeoutSec?: number;
}

export function createAgentHookEntry(
  context: IntegrationContext,
  configDir: string,
  eventType: string,
  matcher: string,
  marker: string,
  scriptPath: string,
  options: AgentHookEntryOptions = {},
): ManagedHookEntry {
  const { projectDirPlaceholder, timeoutSec = HOOK_TIMEOUT_SEC } = options;
  return {
    eventType,
    marker,
    hookConfig: {
      matcher,
      hooks: [
        {
          type: 'command',
          command: resolveAgentHookCommand(context, configDir, scriptPath, projectDirPlaceholder),
          timeout: timeoutSec,
        },
      ],
    },
  };
}

/**
 * Idempotent upsert: for each managed entry, drop any existing entries owned
 * by its marker (any hook whose command contains the marker) and append the
 * desired entry. Returns a new document; does not mutate the input.
 */
export function upsertAgentHooks(document: unknown, entries: ManagedHookEntry[]): HooksDocument {
  const settings = toHooksDocument(document);
  settings.hooks ??= {};

  for (const entry of entries) {
    const existingEntries = settings.hooks[entry.eventType] ?? [];
    settings.hooks[entry.eventType] = [
      ...existingEntries.filter((hook) => !ownsHookEntry(hook, entry.marker)),
      entry.hookConfig,
    ];
  }

  return settings;
}

/**
 * Remove hook entries whose commands contain any of the given markers.
 * Idempotent inverse of {@link upsertAgentHooks} for the same markers.
 */
export function removeAgentHooks(document: unknown, markers: string[]): HooksDocument {
  const settings = toHooksDocument(document);
  if (!settings.hooks) {
    return settings;
  }

  const hooks: NonNullable<HooksDocument['hooks']> = {};
  for (const [eventType, entries] of Object.entries(settings.hooks)) {
    const filtered = (entries ?? []).filter(
      (hook) => !markers.some((marker) => ownsHookEntry(hook, marker)),
    );
    if (filtered.length > 0) {
      hooks[eventType] = filtered;
    }
  }

  return { ...settings, hooks };
}

function ownsHookEntry(entry: HookConfig, marker: string): boolean {
  return entry.hooks.some((hook) => hook.command.includes(marker));
}

function toHooksDocument(document: unknown): HooksDocument {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { hooks: {} };
  }

  const settings = document as HooksDocument;
  return {
    ...settings,
    hooks: settings.hooks ? { ...settings.hooks } : {},
  };
}

/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Codex hooks (~/.codex/hooks.json + scripts under .codex/hooks/) — mirrors Claude layout.

import * as nodeFs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import * as nodeOs from 'node:os';
import { CODEX_AGENT_DIR_NAME, codexHooksJsonPath } from '../../../../lib/config-constants';
import logger from '../../../../lib/logger';
import {
  getCodexSecretPreToolTemplateUnix,
  getCodexSecretPromptTemplateUnix,
  getCodexSqaaPostToolTemplateUnix,
} from './hook-templates';

const HOOKS_DIR = 'hooks';
const SONAR_SECRETS_MARKER = 'sonar-secrets';

interface HookConfig {
  matcher: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout: number;
    /** Shown in Codex UI while the hook runs (see Codex hooks docs). */
    statusMessage?: string;
  }>;
}

/** Root shape of ~/.codex/hooks.json (only the `hooks` object is used). */
interface CodexHooksFile {
  hooks?: Record<string, HookConfig[] | undefined>;
  [key: string]: unknown;
}

interface CodexHookInstallParams {
  installDir: string;
  eventType: string;
  matcher: string;
  scriptPath: string;
  scriptContentUnix: string;
  timeout?: number;
  statusMessage?: string;
}

export interface CodexHooksInstallResult {
  secretsHooksInstalled: boolean;
  sqaaHookInstalled: boolean;
}

function getPlatform(): 'windows' | 'unix' {
  return nodeOs.platform() === 'win32' ? 'windows' : 'unix';
}

function upsertHookEntry(
  root: CodexHooksFile,
  eventType: string,
  marker: string,
  matcher: string,
  command: string,
  timeout: number,
  statusMessage?: string,
): void {
  const isOwned = (e: HookConfig) =>
    Array.isArray(e.hooks) && e.hooks.some((h) => h.command.includes(marker));
  root.hooks ??= {};
  const handler: {
    type: string;
    command: string;
    timeout: number;
    statusMessage?: string;
  } = { type: 'command', command, timeout };
  if (statusMessage) {
    handler.statusMessage = statusMessage;
  }
  root.hooks[eventType] = [
    ...(root.hooks[eventType] ?? []).filter((e) => !isOwned(e)),
    { matcher, hooks: [handler] },
  ];
}

async function installCodexHook(params: CodexHookInstallParams): Promise<void> {
  const {
    installDir,
    eventType,
    matcher,
    scriptPath,
    scriptContentUnix,
    timeout = 60,
    statusMessage,
  } = params;

  const hooksPath = codexHooksJsonPath(installDir);
  let root: CodexHooksFile = { hooks: {} };
  if (nodeFs.existsSync(hooksPath)) {
    const data = await fsPromises.readFile(hooksPath, 'utf-8');
    root = JSON.parse(data) as CodexHooksFile;
  }
  root.hooks ??= {};

  const scriptExt = '.sh';
  const fullScriptDir = join(installDir, CODEX_AGENT_DIR_NAME, HOOKS_DIR, dirname(scriptPath));
  nodeFs.mkdirSync(fullScriptDir, { recursive: true });
  const fullScriptPath = join(fullScriptDir, `${basename(scriptPath)}${scriptExt}`);
  await fsPromises.writeFile(fullScriptPath, scriptContentUnix, { mode: 0o755 });

  // Absolute path for both scopes: Codex runs hooks with session cwd; relative paths break when
  // cwd is not the repo root. `bash -lc '$(git rev-parse …)'` is fragile if git is off-PATH in the
  // hook subprocess. We know `fullScriptPath` at integrate time (same idea as global ~/.codex).
  // @see https://developers.openai.com/codex/hooks#where-codex-looks-for-hooks
  const command = fullScriptPath;
  const marker = scriptPath.split('/')[0];
  upsertHookEntry(root, eventType, marker, matcher, command, timeout, statusMessage);
  await fsPromises.writeFile(hooksPath, JSON.stringify(root, null, 2), 'utf-8');
}

/**
 * Whether this OS can run Codex command hooks (Codex currently disables hooks on Windows).
 */
export function isCodexHooksSupportedOnPlatform(): boolean {
  return getPlatform() === 'unix';
}

/**
 * Same layout as integrate claude: scripts under .codex/hooks/sonar-secrets/... and hooks.json next to config.toml.
 * globalDir === homedir() for user-level ~/.codex (`sonar integrate codex -g`); omit for project `.codex` only (default).
 */
export async function installCodexSecretsHooks(
  projectRoot: string,
  globalDir?: string,
): Promise<boolean> {
  const secretsDir = globalDir ?? projectRoot;
  let preToolInstalled = false;
  let promptInstalled = false;

  try {
    await installCodexHook({
      installDir: secretsDir,
      eventType: 'PreToolUse',
      matcher: 'Bash',
      scriptPath: 'sonar-secrets/build-scripts/pretool-secrets',
      scriptContentUnix: getCodexSecretPreToolTemplateUnix(),
      statusMessage: 'Sonar: scanning Bash command for secrets',
    });
    preToolInstalled = true;
  } catch (error) {
    logger.debug(`Failed to install Codex PreToolUse hook: ${(error as Error).message}`);
  }

  try {
    await installCodexHook({
      installDir: secretsDir,
      eventType: 'UserPromptSubmit',
      matcher: '*',
      scriptPath: 'sonar-secrets/build-scripts/prompt-secrets',
      scriptContentUnix: getCodexSecretPromptTemplateUnix(),
      statusMessage: 'Sonar: scanning prompt for secrets',
    });
    promptInstalled = true;
  } catch (error) {
    logger.debug(`Failed to install Codex UserPromptSubmit hook: ${(error as Error).message}`);
  }

  return preToolInstalled && promptInstalled;
}

/**
 * SQAA PostToolUse hook is always project-scoped (under `<project>/.codex/`), even when secrets use `-g`.
 *
 * Matcher is `Bash` (not Claude’s `Edit|Write`): Codex applies PreToolUse/PostToolUse matchers to
 * `tool_name`, and the runtime currently only emits `Bash` — see Matcher patterns in
 * https://developers.openai.com/codex/hooks
 */
export async function installCodexSqaaHooks(
  projectRoot: string,
  projectKey: string,
): Promise<boolean> {
  try {
    await installCodexHook({
      installDir: projectRoot,
      eventType: 'PostToolUse',
      matcher: 'Bash',
      scriptPath: 'sonar-sqaa/build-scripts/posttool-sqaa',
      scriptContentUnix: getCodexSqaaPostToolTemplateUnix(projectKey),
      statusMessage: 'Sonar: AI analysis on edited files',
    });
    return true;
  } catch (error) {
    logger.debug(`Failed to install Codex SQAA hooks: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Install sonar-secrets and optionally SQAA hooks (same signature idea as Claude `installHooks`).
 */
export async function installCodexHooks(
  projectRoot: string,
  globalDir: string | undefined,
  installSqaa = false,
  projectKey?: string,
): Promise<CodexHooksInstallResult> {
  const secretsHooksInstalled = await installCodexSecretsHooks(projectRoot, globalDir);
  const sqaaHookInstalled =
    installSqaa && projectKey && isCodexHooksSupportedOnPlatform()
      ? await installCodexSqaaHooks(projectRoot, projectKey)
      : false;

  return { secretsHooksInstalled, sqaaHookInstalled };
}

/**
 * hooksRoot is the directory that contains `.codex/` (either homedir or project root).
 */
export async function areCodexSecretsHooksInstalled(hooksRoot: string): Promise<boolean> {
  const hooksPath = codexHooksJsonPath(hooksRoot);

  if (!nodeFs.existsSync(hooksPath)) {
    return false;
  }

  try {
    const data = await fsPromises.readFile(hooksPath, 'utf-8');
    const root = JSON.parse(data) as CodexHooksFile;

    const hasSonarEntry = (marker: string, event: HookConfig[] | undefined): boolean =>
      Boolean(
        event &&
        Array.isArray(event) &&
        event.some(
          (cfg) => Array.isArray(cfg.hooks) && cfg.hooks.some((h) => h.command.includes(marker)),
        ),
      );

    return (
      hasSonarEntry(SONAR_SECRETS_MARKER, root.hooks?.PreToolUse) &&
      hasSonarEntry(SONAR_SECRETS_MARKER, root.hooks?.UserPromptSubmit)
    );
  } catch {
    return false;
  }
}

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

// Auth and project-key resolution for SQAA commands.

import { resolve } from 'node:path';

import type { Command } from 'commander';

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import logger from '../../../lib/logger';
import { spawnProcess } from '../../../lib/process';
import { loadState } from '../../../lib/repository/state-repository';
import type { HookExtension } from '../../../lib/state';
import { findExtensionsByProject } from '../../../lib/state-manager';
import { blank, confirmPrompt, text, warn } from '../../../ui';
import { CommandFailedError } from '../_common/error.js';

const LARGE_CHANGESET_HINT =
  'For faster feedback, try targeting your changes:\n' +
  '  --staged          analyze only staged files\n' +
  '  --base <ref>      analyze files changed vs a branch (e.g. --base main)\n' +
  '  --file <path>     analyze a single specific file';

/** Cloud authentication context required for SQAA API calls. */
export interface CloudAuth {
  serverUrl: string;
  token: string;
  orgKey: string;
}

/**
 * Combines cloud-auth validation and project-key resolution.
 * Returns null (with a warning already printed) when SQAA should be skipped.
 */
export async function resolveCloudAuthAndProject(
  auth: ResolvedAuth,
  explicitProject: string | undefined,
  command: Command | undefined,
  projectRoot?: string,
): Promise<{ cloudAuth: CloudAuth; projectKey: string } | null> {
  const cloudAuth = resolveCloudAuth(auth, explicitProject);
  if (!cloudAuth) return null;

  const projectKey = explicitProject ?? (await resolveSqaaProjectKey(command, projectRoot));
  if (!projectKey) {
    warn(
      'SonarQube Agentic Analysis skipped: no project configured. Specify one with --project or run: sonar integrate claude',
    );
    return null;
  }

  return { cloudAuth, projectKey };
}

/**
 * Validate that the resolved auth is for SonarQube Cloud.
 * Returns null when the connection is not Cloud and --project is not set.
 * Throws CommandFailedError when --project is set but the connection is not Cloud.
 */
export function resolveCloudAuth(
  auth: ResolvedAuth,
  explicitProject: string | undefined,
): CloudAuth | null {
  if (auth.connectionType != 'cloud' || auth.orgKey == null) {
    if (explicitProject) {
      throw new CommandFailedError(
        'SonarQube Agentic Analysis requires a SonarQube Cloud connection. Run: sonar auth login',
      );
    }
    warn(
      'SonarQube Agentic Analysis skipped: a SonarQube Cloud connection is required. Run: sonar auth login (ensure you connect to SonarQube Cloud)',
    );
    return null;
  }

  return { serverUrl: auth.serverUrl, token: auth.token, orgKey: auth.orgKey };
}

/**
 * Look up the project key for the current project from the agentExtensions registry.
 *
 * The registry keys extensions by project root (the directory passed to
 * `sonar integrate claude`), so when the user runs SQAA from a subdirectory we
 * have to resolve the git repository top-level first — otherwise `process.cwd()`
 * is a non-match against the registered root and we incorrectly skip with
 * "no project configured".
 *
 * Falls back to `process.cwd()` when not inside a git repository so the
 * single-file path still works outside git.
 */
export async function resolveSqaaProjectKey(
  command?: Command,
  projectRoot?: string,
): Promise<string | null> {
  try {
    const root = projectRoot ?? (await tryResolveRepoRoot(process.cwd()));
    const state = loadState();
    const extensions = findExtensionsByProject(state, 'claude-code', root);
    const sqaaExt = extensions.find(
      (e): e is HookExtension => e.kind === 'hook' && e.name === 'sonar-sqaa',
    );

    if (!sqaaExt?.projectKey) {
      logger.debug(
        'SonarQube Agentic Analysis skipped: no project key found in extensions registry',
      );
      if (process.stdin.isTTY) {
        command?.outputHelp();
      }
      return null;
    }

    return sqaaExt.projectKey;
  } catch {
    logger.debug('SonarQube Agentic Analysis skipped: failed to resolve extensions');
    return null;
  }
}

/**
 * Resolve the git repository top-level for `cwd`, falling back to `cwd` itself
 * when not inside a git repository (so non-git workflows still work).
 */
async function tryResolveRepoRoot(cwd: string): Promise<string> {
  try {
    const result = await spawnProcess('git', ['rev-parse', '--show-toplevel'], { cwd });
    if (result.exitCode === 0) {
      return resolve(result.stdout.trim());
    }
  } catch {
    // git not installed or otherwise unavailable — fall through to cwd.
  }
  return cwd;
}

/**
 * Warn about a large change set and ask the user to confirm.
 * In non-interactive contexts (no stdin TTY — e.g. CI/agent runs), prints a
 * warning and auto-proceeds. Returns false only when the user explicitly declines in an interactive terminal.
 */
export async function confirmLargeChangeset(fileCount: number): Promise<boolean> {
  blank();
  warn(
    `You are about to analyze a large number of files (${fileCount}). This may take longer to process.\n${LARGE_CHANGESET_HINT}`,
  );

  if (!process.stdin.isTTY) {
    return true;
  }

  blank();
  const confirmed = await confirmPrompt('Do you wish to proceed?');
  if (!confirmed) {
    blank();
    text('Analysis cancelled. Use --force to bypass the file count check.');
    return false;
  }
  return true;
}

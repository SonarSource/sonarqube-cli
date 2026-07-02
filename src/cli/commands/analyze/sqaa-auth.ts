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

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import logger from '../../../lib/logger';
import { spawnProcess } from '../../../lib/process';
import { resolveWorktreeEquivalentPaths } from '../../../lib/project-workspace/git-worktree';
import { loadState } from '../../../lib/repository/state-repository';
import { canonicalProjectRoot } from '../../../lib/state-manager';
import { blank, confirmPrompt, text, warn } from '../../../ui';
import { CommandFailedError } from '../_common/error.js';
import { SQAA_HOOK_FEATURE_ID } from '../integrate/_common/sqaa-entitlement';
import { CLAUDE_INTEGRATION_ID } from '../integrate/claude/declaration';

const LARGE_CHANGESET_HINT =
  'For faster feedback, try targeting your changes:\n' +
  '  --staged          analyze only staged files\n' +
  '  --base <ref>      analyze files changed vs a branch (e.g. --base main)\n' +
  '  --file <path>     analyze specific file(s) — repeat for multiple files\n' +
  '  --depth STANDARD  faster analysis (change-set / multi-file default is DEEP)';

/** Cloud authentication context required for SQAA API calls. */
export interface CloudAuth {
  serverUrl: string;
  token: string;
  orgKey: string;
}

/**
 * Outcome of resolving cloud auth + project key for SQAA. This resolver reports
 * what it found and leaves the policy (skip vs. fail) to the caller:
 * - `resolved`: usable cloud auth and project key.
 * - `no-cloud`: connection is not SonarQube Cloud (a warning was already emitted,
 *   since agentic analysis is Cloud-only and this is always a graceful skip).
 * - `no-project`: cloud auth is fine but no project is configured. The caller
 *   decides whether this is an error or a graceful skip.
 */
export type SqaaAuthResolution =
  | { kind: 'resolved'; cloudAuth: CloudAuth; projectKey: string }
  | { kind: 'no-cloud' }
  | { kind: 'no-project' };

/**
 * Combines cloud-auth validation and project-key resolution. Pure with respect to
 * the missing-project case: it never throws or warns for `no-project` — the caller
 * owns that decision (see `resolveSqaaContext` in sqaa.ts).
 */
export async function resolveCloudAuthAndProject(
  auth: ResolvedAuth,
  explicitProject: string | undefined,
  projectRoot?: string,
): Promise<SqaaAuthResolution> {
  const cloudAuth = resolveCloudAuth(auth, explicitProject);
  if (!cloudAuth) return { kind: 'no-cloud' };

  const projectKey = explicitProject ?? (await resolveSqaaProjectKey(projectRoot));
  if (!projectKey) return { kind: 'no-project' };

  return { kind: 'resolved', cloudAuth, projectKey };
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
        'Vortex agentic analysis requires a SonarQube Cloud connection.',
        {
          remediationHint: "Run 'sonar auth login' and connect to SonarQube Cloud, then retry.",
        },
      );
    }
    warn(
      'Vortex agentic analysis skipped: a SonarQube Cloud connection is required. Run: sonar auth login (ensure you connect to SonarQube Cloud)',
    );
    return null;
  }

  return { serverUrl: auth.serverUrl, token: auth.token, orgKey: auth.orgKey };
}

/**
 * Look up the project key for the current project from the declarative
 * integration state (`integrations.installed`).
 *
 * The SQAA hook feature is recorded per install target root (the directory
 * passed to `sonar integrate claude`), so when the user runs SQAA from a
 * subdirectory we resolve the git repository top-level first — otherwise
 * `process.cwd()` is a non-match against the recorded root and we incorrectly
 * skip with "no project configured". We also try the root's equivalent in the
 * repository's main working tree, so a linked worktree still resolves state
 * recorded in the main checkout.
 *
 * Falls back to `process.cwd()` when not inside a git repository so the
 * single-file path still works outside git.
 */
export async function resolveSqaaProjectKey(projectRoot?: string): Promise<string | null> {
  try {
    const root = projectRoot ?? (await tryResolveRepoRoot(process.cwd()));
    const state = loadState();

    const claude = state.integrations.installed.find(
      (integration) => integration.integrationId === CLAUDE_INTEGRATION_ID,
    );
    // Try the repo root, then its equivalent in the main working tree, so a
    // linked worktree still resolves state recorded in the main checkout.
    const candidates = new Set(
      (await resolveWorktreeEquivalentPaths(root)).map(canonicalProjectRoot),
    );
    const sqaaFeature = claude?.features.find(
      (feature) =>
        feature.featureId === SQAA_HOOK_FEATURE_ID &&
        feature.scope === 'project' &&
        candidates.has(canonicalProjectRoot(feature.targetRoot)),
    );

    const projectKey = sqaaFeature?.attrs?.projectKey;
    if (typeof projectKey !== 'string' || projectKey.length === 0) {
      logger.debug('Vortex agentic analysis skipped: no project key found in integration state');
      return null;
    }

    return projectKey;
  } catch {
    logger.debug('Vortex agentic analysis skipped: failed to resolve integration state');
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
  const confirmed = await confirmPrompt('Do you wish to proceed?', true);
  if (!confirmed) {
    blank();
    text('Analysis cancelled. Use --force to bypass the file count check.');
    return false;
  }
  return true;
}

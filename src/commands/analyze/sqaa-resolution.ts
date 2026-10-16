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

// Connection and project-key resolution for SQAA commands.

import { isSonarQubeCloud, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import {
  type DiscoveredProject,
  discoverProject,
  type DiscoverProjectOptions,
} from '@/core/project-discovery/project-info.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';
import type { Console } from '@/core/ui/console.ts';

const LARGE_CHANGESET_HINT =
  'For faster feedback, try targeting your changes:\n' +
  '  --staged          analyze only staged files\n' +
  '  --base <ref>      analyze files changed vs a branch (e.g. --base main)\n' +
  '  --file <path>     analyze specific file(s), repeat for multiple files\n' +
  '  --depth STANDARD  faster analysis (change-set / multi-file default is DEEP)';

/**
 * Outcome of resolving a connection + project key for SQAA. This resolver reports
 * what it found and leaves the policy (skip vs. fail) to the caller:
 * - `resolved`: usable connection and project key.
 * - `no-org`: Cloud is authenticated but has no organization. `explicitProject` tells the
 *   caller whether the user named a project, which is what makes this fatal rather than a skip.
 * - `no-project`: auth is fine but no project is configured. The caller
 *   decides whether this is an error or a graceful skip.
 */
export type SqaaResolution =
  | { kind: 'resolved'; connection: SonarConnection; projectKey: string; projectRoot: string }
  | { kind: 'no-org'; explicitProject: boolean }
  | { kind: 'no-project' };

/**
 * Checks the connection is usable for SQAA and resolves the project key. Never throws or warns — every
 * unusable outcome comes back as a `kind`, and the caller owns what it means
 * (see `resolveSqaaContext` in sqaa-context.ts).
 *
 * Not side-effect-free: on a successful resolution it publishes the project key for
 * `project_uuid` telemetry (see `noteProject`). This is the single choke point for every SQAA
 * entry point — bare `sonar analyze`, `analyze agentic`, and `verify` — so noting here covers
 * all of them instead of at each of the five downstream call sites.
 */
export async function resolveSqaaConnectionAndProject(
  connection: SonarConnection,
  explicitProject: string | undefined,
  console: Console,
  startDir?: string,
): Promise<SqaaResolution> {
  const { auth } = connection;
  if (isSonarQubeCloud(auth.serverUrl) && !auth.orgKey) {
    return { kind: 'no-org', explicitProject: Boolean(explicitProject) };
  }

  const lookupDir = startDir ?? process.cwd();
  const discovered = await discoverSqaaProject(auth, console, lookupDir, {
    useGitRemoteBinding: !explicitProject,
  });
  const projectKey = explicitProject ?? discovered.projectKey;
  if (!projectKey) return { kind: 'no-project' };

  noteProject(auth, projectKey);
  return {
    kind: 'resolved',
    connection,
    projectKey,
    projectRoot: resolveSqaaProjectRoot(discovered, projectKey, lookupDir),
  };
}

/**
 * A discovered root only describes the discovered key, so an explicit `--project` naming a
 * different one falls back to the repository root.
 */
function resolveSqaaProjectRoot(
  discovered: DiscoveredProject,
  projectKey: string,
  lookupDir: string,
): string {
  if (discovered.projectKey === projectKey) return discovered.projectRoot;
  return discovered.repoRoot ?? canonicalizePath(lookupDir);
}

/**
 * Look up the current project via the shared project-discovery pipeline
 * (`discoverProject`): the known-server-project-mapping cache, local config files, then a
 * git-remote-binding lookup against the server. Falls back to `process.cwd()` when no
 * `startDir` is given, so it works from a subdirectory or outside git.
 */
export async function discoverSqaaProject(
  auth: ResolvedAuth,
  console: Console,
  startDir?: string,
  options: Pick<DiscoverProjectOptions, 'useGitRemoteBinding'> = {},
): Promise<DiscoveredProject> {
  const discovered = await discoverProject(startDir ?? process.cwd(), {
    auth,
    silent: true,
    console,
    ...options,
  });
  if (!discovered.projectKey) {
    logger.debug('Vortex analysis: no project key discovered');
  }
  return discovered;
}

/**
 * Warn about a large change set and ask the user to confirm.
 * In non-interactive contexts (no stdin TTY — e.g. CI/agent runs), prints a
 * warning and auto-proceeds. Returns false only when the user explicitly declines in an interactive terminal.
 */
export async function confirmLargeChangeset(fileCount: number, console: Console): Promise<boolean> {
  console.blank();
  console.warn(
    `You are about to analyze a large number of files (${fileCount}). This may take longer to process.\n${LARGE_CHANGESET_HINT}`,
  );

  if (!process.stdin.isTTY && !process.env.SONARQUBE_CLI_MOCK_TTY) {
    return true;
  }

  console.blank();
  printAgentNonInteractiveAlternativeHint(console, 'sonar analyze --force');
  const confirmed = await console.confirmPrompt('Do you wish to proceed?', true);
  if (!confirmed) {
    console.blank();
    console.text('Analysis cancelled. Use --force to bypass the file count check.');
    return false;
  }
  return true;
}

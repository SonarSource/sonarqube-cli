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

// Request-target and project-key resolution for SQAA commands.

import { isSonarQubeCloud, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import logger from '@/core/observability/logger.ts';
import { discoverProject } from '@/core/project-info.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';
import type { Console } from '@/core/ui/console.ts';

const LARGE_CHANGESET_HINT =
  'For faster feedback, try targeting your changes:\n' +
  '  --staged          analyze only staged files\n' +
  '  --base <ref>      analyze files changed vs a branch (e.g. --base main)\n' +
  '  --file <path>     analyze specific file(s) — repeat for multiple files\n' +
  '  --depth STANDARD  faster analysis (change-set / multi-file default is DEEP)';

/** `orgKey` is Cloud-only: Server has no organizations and its A3S hub forces the instance default. */
export interface SqaaRequestTarget {
  orgKey?: string;
  transport: SonarHttpClient;
}

/**
 * Outcome of resolving a request target + project key for SQAA. This resolver reports
 * what it found and leaves the policy (skip vs. fail) to the caller:
 * - `resolved`: usable target and project key.
 * - `no-org`: Cloud is authenticated but has no organization. `explicitProject` tells the
 *   caller whether the user named a project, which is what makes this fatal rather than a skip.
 * - `no-project`: auth is fine but no project is configured. The caller
 *   decides whether this is an error or a graceful skip.
 */
export type SqaaResolution =
  | { kind: 'resolved'; target: SqaaRequestTarget; projectKey: string }
  | { kind: 'no-org'; explicitProject: boolean }
  | { kind: 'no-project' };

/**
 * Combines target resolution and project-key resolution. Never throws or warns — every
 * unusable outcome comes back as a `kind`, and the caller owns what it means
 * (see `resolveSqaaContext` in sqaa-context.ts).
 *
 * Not side-effect-free: on a successful resolution it publishes the project key for
 * `project_uuid` telemetry (see `noteProject`). This is the single choke point for every SQAA
 * entry point — bare `sonar analyze`, `analyze agentic`, and `verify` — so noting here covers
 * all of them instead of at each of the five downstream call sites.
 */
export async function resolveSqaaTargetAndProject(
  transport: SonarHttpClient,
  auth: ResolvedAuth,
  explicitProject: string | undefined,
  console: Console,
  projectRoot?: string,
): Promise<SqaaResolution> {
  if (isSonarQubeCloud(auth.serverUrl) && !auth.orgKey) {
    return { kind: 'no-org', explicitProject: Boolean(explicitProject) };
  }

  const projectKey = explicitProject ?? (await resolveSqaaProjectKey(auth, console, projectRoot));
  if (!projectKey) return { kind: 'no-project' };

  noteProject(auth, projectKey);
  return {
    kind: 'resolved',
    target: { ...(auth.orgKey ? { orgKey: auth.orgKey } : {}), transport },
    projectKey,
  };
}

/**
 * Look up the project key for the current project via the shared project-discovery
 * pipeline (`discoverProject`): the known-server-project-mapping cache, local config
 * files, then a git-remote-binding lookup against the server. Falls back to
 * `process.cwd()` when no `projectRoot` is given so the single-file path still
 * works, including from a subdirectory or outside git.
 */
export async function resolveSqaaProjectKey(
  auth: ResolvedAuth,
  console: Console,
  projectRoot?: string,
): Promise<string | null> {
  const discovered = await discoverProject(projectRoot ?? process.cwd(), {
    auth,
    silent: true,
    console,
  });
  if (!discovered.projectKey) {
    logger.debug('Vortex analysis skipped: no project key found');
  }
  return discovered.projectKey ?? null;
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

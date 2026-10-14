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
import logger from '@/core/observability/logger.ts';
import { discoverProject } from '@/core/project-info.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';
import type { Console } from '@/core/ui/console.ts';

import type { SqaaProject } from './sqaa-types.ts';

const LARGE_CHANGESET_HINT =
  'For faster feedback, try targeting your changes:\n' +
  '  --staged          analyze only staged files\n' +
  '  --base <ref>      analyze files changed vs a branch (e.g. --base main)\n' +
  '  --file <path>     analyze specific file(s), repeat for multiple files\n' +
  '  --depth STANDARD  faster analysis (change-set / multi-file default is DEEP)';

/**
 * Outcome of resolving a connection + project key for SQAA. This resolver reports
 * what it found and leaves the policy (skip vs. fail) to the caller:
 * - `resolved`: usable connection, project key, and the root that key is anchored at.
 * - `no-org`: Cloud is authenticated but has no organization. `explicitProject` tells the
 *   caller whether the user named a project, which is what makes this fatal rather than a skip.
 * - `no-project`: auth is fine but no project is configured. The caller
 *   decides whether this is an error or a graceful skip.
 */
export type SqaaResolution =
  | ({ kind: 'resolved'; connection: SonarConnection } & SqaaProject)
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
  project: string | SqaaProject | undefined,
  console: Console,
  startDir?: string,
  fallbackRoot?: string,
): Promise<SqaaResolution> {
  const { auth } = connection;
  if (isSonarQubeCloud(auth.serverUrl) && !auth.orgKey) {
    return { kind: 'no-org', explicitProject: Boolean(project) };
  }

  const resolved =
    typeof project === 'object'
      ? project
      : await discoverSqaaProject(auth, console, project, startDir ?? process.cwd(), fallbackRoot);
  if (!resolved) return { kind: 'no-project' };

  noteProject(auth, resolved.projectKey);
  return { kind: 'resolved', connection, ...resolved };
}

/**
 * Resolves the key and the root A3S paths must be relative to. An explicit key
 * skips git-remote binding, the only source that calls the server, and keeps the discovered
 * root only when discovery found that same key: another project's root would misbase paths.
 * Otherwise the root is `fallbackRoot` (default `startDir`), which a change set sets to the
 * repository root so that falling back never narrows what gets analyzed.
 */
async function discoverSqaaProject(
  auth: ResolvedAuth,
  console: Console,
  explicitKey: string | undefined,
  startDir: string,
  fallbackRoot: string = startDir,
): Promise<SqaaProject | null> {
  const discovered = await discoverProject(startDir, {
    auth: explicitKey === undefined ? auth : null,
    silent: true,
    console,
  });
  const projectKey = explicitKey ?? discovered.projectKey;
  if (!projectKey) {
    logger.debug('Vortex analysis skipped: no project key found');
    return null;
  }
  if (discovered.projectKey === projectKey) {
    return { projectKey, projectRoot: discovered.projectRoot };
  }
  logger.debug(
    `Project ${projectKey} is not the discovered ${discovered.projectKey ?? 'project'}; paths are relative to ${fallbackRoot}`,
  );
  return { projectKey, projectRoot: fallbackRoot };
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

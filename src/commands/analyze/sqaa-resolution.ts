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
import { authMatchesRecordedConnection } from '@/core/auth/recorded-connection.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import type { DiscoveredProjects } from '@/core/project-discovery/project-discovery-result.ts';
import {
  type DiscoverProjectOptions,
  discoverProjects,
} from '@/core/project-discovery/project-info.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';
import type { Console } from '@/core/ui/console.ts';

import { isInsideProjectRoot } from './sqaa-paths.ts';
import type { SqaaProjectGroup } from './sqaa-types.ts';

const LARGE_CHANGESET_HINT =
  'For faster feedback, try targeting your changes:\n' +
  '  --staged          analyze only staged files\n' +
  '  --base <ref>      analyze files changed vs a branch (e.g. --base main)\n' +
  '  --file <path>     analyze specific file(s), repeat for multiple files\n' +
  '  --depth STANDARD  faster analysis (change-set / multi-file default is DEEP)';

/**
 * Outcome of resolving a connection + projects for SQAA. This resolver reports
 * what it found and leaves the policy (skip vs. fail) to the caller:
 * - `resolved`: usable connection, with the files split per project (`groups`) and the files
 *   no project owns (`unmapped`). Both can be empty-handed: every file may be unmapped.
 * - `no-org`: Cloud is authenticated but has no organization. `explicitProject` tells the
 *   caller whether the user named a project, which is what makes this fatal rather than a skip.
 * - `no-project`: auth is fine but no project is configured. The caller
 *   decides whether this is an error or a graceful skip.
 */
export type SqaaResolution =
  | {
      kind: 'resolved';
      connection: SonarConnection;
      groups: SqaaProjectGroup[];
      unmapped: string[];
      otherConnection: string[];
      projectRoots: string[];
    }
  | { kind: 'no-org'; explicitProject: boolean }
  | { kind: 'no-project' };

/**
 * Checks the connection is usable for SQAA and assigns each of `files` to its project. Never
 * throws or warns — every unusable outcome comes back as a `kind`, and the caller owns what it
 * means (see `resolveSqaaContext` in sqaa-context.ts).
 *
 * Without `explicitProject`, each file goes to the project with the deepest root containing it,
 * so a monorepo's files fan out to several projects. An explicit project pins every file to it.
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
  files: string[],
  startDir?: string,
): Promise<SqaaResolution> {
  const { auth } = connection;
  if (isSonarQubeCloud(auth.serverUrl) && !auth.orgKey) {
    return { kind: 'no-org', explicitProject: Boolean(explicitProject) };
  }

  const lookupDir = startDir ?? process.cwd();
  // An explicit --project already supplies the key, so skip the git-remote binding lookup
  // (a server round trip). Discovery still runs because the project root is needed to build
  // server paths, and known mappings and local config are enough to find it.
  const discovered = await discoverSqaaProjects(auth, console, lookupDir, {
    useGitRemoteBinding: !explicitProject,
  });

  if (explicitProject) {
    noteProject(auth, explicitProject);
    const projectRoot = resolveExplicitProjectRoot(discovered, explicitProject, lookupDir);
    const inside = files.filter((file) => isInsideProjectRoot(file, projectRoot));
    return {
      kind: 'resolved',
      connection,
      groups:
        inside.length > 0 ? [{ projectKey: explicitProject, projectRoot, files: inside }] : [],
      unmapped: files.filter((file) => !inside.includes(file)),
      otherConnection: [],
      projectRoots: [projectRoot],
    };
  }

  // Run from inside a project, only that project (the closest) is analyzed; run from above
  // several, all of them. Files owned by any other project are unmapped, not analyzed.
  const focused = discovered.focusedOn(lookupDir);
  const { groups: allGroups, unmapped } = focused.groupByMapping(files);
  // Source goes through the active connection only, so a project recorded against another
  // server or organization is never uploaded to it. Grouping stays nearest-wins first, so
  // a file of such a nested project is not handed to the project above it.
  const groups = allGroups.filter(({ mapping }) => authMatchesRecordedConnection(auth, mapping));
  const otherConnection = allGroups
    .filter(({ mapping }) => !authMatchesRecordedConnection(auth, mapping))
    .flatMap(({ paths }) => paths);
  // Nothing configured for the directory the command runs in, not merely for these files:
  // that stays the "no project" outcome rather than a run that silently excludes everything.
  if (groups.length === 0 && focused.projects.length === 0) {
    logger.debug('Vortex analysis: no project key discovered');
    return { kind: 'no-project' };
  }

  // `project_uuid` holds one project, so a run spanning several leaves it unset rather than
  // attributing the whole run to one of them.
  const keys =
    groups.length > 0
      ? groups.map(({ mapping }) => mapping.projectKey)
      : focused.projects.map((mapping) => mapping.projectKey);
  const [firstKey] = keys;
  if (keys.every((key) => key === firstKey)) noteProject(auth, firstKey);

  return {
    kind: 'resolved',
    connection,
    groups: groups.map(({ mapping, paths }) => ({
      projectKey: mapping.projectKey,
      projectRoot: mapping.projectRoot,
      files: paths,
    })),
    unmapped,
    otherConnection,
    projectRoots: focused.projects.map((mapping) => mapping.projectRoot),
  };
}

/**
 * A discovered mapping only describes its own key, so an explicit `--project` naming one that
 * discovery did not find falls back to the repository root.
 */
function resolveExplicitProjectRoot(
  discovered: DiscoveredProjects,
  projectKey: string,
  lookupDir: string,
): string {
  const mapping = discovered.projects.find((project) => project.projectKey === projectKey);
  return mapping?.projectRoot ?? discovered.repoRoot ?? canonicalizePath(lookupDir);
}

/**
 * Look up every project mapping for the directory via the shared project-discovery pipeline
 * (`discoverProjects`): shared project config, the known-server-project-mapping cache, local
 * config files, then a git-remote-binding lookup against the server. Falls back to
 * `process.cwd()` when no `startDir` is given, so it works from a subdirectory or outside git.
 */
export function discoverSqaaProjects(
  auth: ResolvedAuth,
  console: Console,
  startDir?: string,
  options: Pick<DiscoverProjectOptions, 'useGitRemoteBinding'> = {},
): Promise<DiscoveredProjects> {
  return discoverProjects(startDir ?? process.cwd(), {
    auth,
    silent: true,
    console,
    ...options,
  });
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

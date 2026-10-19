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

// Project workspace: git root, sonar-project.properties, SonarLint connected mode

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { findGitRoot } from '@/core/host/git/discover.ts';
import { type LookupPath, resolveLookupPaths } from '@/core/host/git/lookup-path-resolver.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import {
  applyKnownServerProjectMapping,
  collectKnownRoots,
  type KnownMappingsResult,
  loadKnownMappings,
} from '@/core/project-discovery/known-server-project-mapping-resolution.ts';
import { applyLocalConfigAcrossLookupPaths } from '@/core/project-discovery/local-project-config.ts';
import { formatConfigFields } from '@/core/project-discovery/project-discovery-format.ts';
import {
  type CompleteProjectMapping,
  DiscoveredProjects,
  isCompleteProjectMapping,
  isSameConnection,
  type PartialProjectMapping,
  ProjectDiscoveryResult,
} from '@/core/project-discovery/project-discovery-result.ts';
import {
  type SharedProjectConfigMapping,
  sharedProjectConfigRepository,
} from '@/core/project-discovery/shared-project-config.ts';
import { applyGitRemoteBinding } from '@/core/server/discover-project-by-remote.ts';
import type { Console } from '@/core/ui/console.ts';

export { KNOWN_SERVER_PROJECT_MAPPING_SOURCE } from '@/core/project-discovery/known-server-project-mapping-resolution.ts';
export const SHARED_PROJECT_CONFIG_SOURCE = 'shared project config';

export interface DiscoveredProject {
  /** Where the discovered project is anchored — what nearly every caller should use. */
  projectRoot: string;
  projectKey?: string;
  serverUrl?: string;
  organization?: string;
  /** Current git worktree root, or undefined outside git. Not a stand-in for `projectRoot` — a monorepo's project is routinely a subdirectory of the repo. */
  repoRoot?: string;
}

export interface DiscoverProjectOptions {
  /**
   * Resolved auth for git-remote binding. Callers that need git-remote lookup must resolve
   * auth first (for example via `ctx.resolveAuth()`) and pass the result; omitting `auth`
   * skips git-remote binding. Pass `null` to skip git-remote binding entirely.
   */
  auth?: ResolvedAuth | null;
  /**
   * When false, skips known-server-project-mapping (pre-login discovery uses false so active
   * connection state cannot masquerade as project config during `sonar auth login`).
   */
  useKnownMappings?: boolean;
  /** Suppresses the "Found ..." stderr hints. Defaults to false. */
  silent?: boolean;
  console: Console;
}

/** Unlike `discoverProject()`, accepts a partial match — these callers never read `projectKey`. */
async function discoverLocalConfig(
  startDir: string,
  silent: boolean,
  console: Console,
): Promise<Pick<DiscoveredProject, 'serverUrl' | 'organization'>> {
  const invocationDir = canonicalizePath(startDir);
  const result = await discoverProjectMappings(startDir, {
    auth: null,
    silent,
    console,
    useKnownMappings: false,
  });
  const scoped = result.scope(invocationDir);
  // Several scoped mappings aren't ambiguous here the way they are for discoverProject(): projectKey is never read.
  const mapping = scoped.length <= 1 || isSameConnection(scoped) ? scoped.at(0) : undefined;
  return { serverUrl: mapping?.serverUrl, organization: mapping?.organization };
}

/** Try to find server URL from project configs. */
export async function discoverServer(console: Console): Promise<string | null> {
  try {
    const { serverUrl } = await discoverLocalConfig(process.cwd(), false, console);
    return serverUrl ?? null;
  } catch (error) {
    logger.debug(`Error finding server in configs: ${(error as Error).message}`);
    return null;
  }
}

/** Try to find organization from project configs. */
export async function discoverOrganization(console: Console): Promise<string | null> {
  try {
    const { organization } = await discoverLocalConfig(process.cwd(), true, console);
    return organization ?? null;
  } catch {
    return null;
  }
}

/** Falls back to the three single-valued sources (known-server-project-mapping, local config, git-remote binding) when shared project config resolved nothing. */
async function discoverProjectWithoutSharedConfig(
  invocationDir: string,
  lookupPaths: LookupPath[],
  knownMappings: KnownMappingsResult | undefined,
  repoRoot: string | undefined,
  options: DiscoverProjectOptions,
): Promise<PartialProjectMapping[]> {
  const single: PartialProjectMapping = { projectRoot: invocationDir };

  const resolved =
    (options.useKnownMappings !== false &&
      knownMappings !== undefined &&
      applyKnownServerProjectMapping(single, lookupPaths, knownMappings, options)) ||
    (await applyLocalConfigAcrossLookupPaths(single, lookupPaths, options));

  if (!resolved) {
    await applyGitRemoteBinding(single, repoRoot, options);
  }

  return single.projectKey || single.serverUrl ? [single] : [];
}

/**
 * Tries each source in turn — shared project config (the only one that can resolve more
 * than one project), then known-server-project-mapping, local config, then git-remote
 * binding — the first three walking the same nearest-first `resolveLookupPaths` list, so
 * "closer wins" uniformly. Never throws — degrades to whatever was already resolved.
 * Internal only: callers outside this file use `discoverProjects()`, which hides the
 * `PartialProjectMapping` case this can produce.
 */
async function discoverProjectMappings(
  startDir: string,
  options: DiscoverProjectOptions,
): Promise<ProjectDiscoveryResult> {
  const result = new ProjectDiscoveryResult();

  try {
    const invocationDir = canonicalizePath(startDir);
    const { gitRoot, isGit } = findGitRoot(startDir);
    const repoRoot = isGit ? canonicalizePath(gitRoot) : undefined;
    result.repoRoot = repoRoot;

    const knownMappings = loadKnownMappings();
    const lookupPaths = await resolveLookupPaths(startDir, collectKnownRoots(knownMappings));
    logger.debug(
      `Project discovery lookup paths (nearest first): ${lookupPaths.map((p) => p.checkPath).join(', ')}`,
    );

    const sharedConfigProjects = await resolveSharedProjectConfigMappings(lookupPaths, options);
    result.projects =
      sharedConfigProjects ??
      (await discoverProjectWithoutSharedConfig(
        invocationDir,
        lookupPaths,
        knownMappings,
        repoRoot,
        options,
      ));
  } catch (error) {
    // No caller treats this as fallible — degrade to whatever was already resolved
    // rather than throwing out of a git hook, agent hook, or long-running MCP server.
    logger.debug(`Project discovery failed, returning partial result: ${(error as Error).message}`);
  }

  logger.debug(`Discovered projects: ${JSON.stringify(result.projects)}`);
  return result;
}

/** Public counterpart to `discoverProjectMappings()` — never exposes a `PartialProjectMapping`. */
export async function discoverProjects(
  startDir: string,
  options: DiscoverProjectOptions,
): Promise<DiscoveredProjects> {
  const result = await discoverProjectMappings(startDir, options);
  return new DiscoveredProjects(result.repoRoot, result.projects.filter(isCompleteProjectMapping));
}

/** Zero or ambiguous matches both degrade to "nothing resolved". */
export async function discoverProject(
  startDir: string,
  options: DiscoverProjectOptions,
): Promise<DiscoveredProject> {
  const invocationDir = canonicalizePath(startDir);
  const result = await discoverProjects(startDir, options);
  const scoped = result.scope(invocationDir);
  const mapping = scoped.length > 1 ? undefined : scoped.at(0);
  return {
    projectRoot: mapping?.projectRoot ?? invocationDir,
    projectKey: mapping?.projectKey,
    serverUrl: mapping?.serverUrl,
    organization: mapping?.organization,
    repoRoot: result.repoRoot,
  };
}

/**
 * Resolve a project key for a command: an explicit `--project` wins outright, otherwise falls
 * back to `discoverProject()`. Throws `CommandFailedError` when neither resolves anything.
 * `silent` (same convention as `discoverProject`) suppresses the "Using ... project key" stderr
 * hints, for commands whose entire output must be a single clean payload.
 */
export async function resolveProjectKey(
  explicitProject: string | undefined,
  auth: ResolvedAuth,
  console: Console,
  silent = false,
): Promise<string> {
  if (explicitProject) {
    assertSingleLineProjectKey(explicitProject);
    if (!silent) {
      console.print(`     Using project key: ${explicitProject}`, 'stderr');
    }
    return explicitProject;
  }

  const discovered = await discoverProject(process.cwd(), {
    auth,
    silent: true,
    console,
  });
  if (discovered.projectKey) {
    assertSingleLineProjectKey(discovered.projectKey);
    if (!silent) {
      console.print(`     Using auto-detected project key: ${discovered.projectKey}`, 'stderr');
    }
    return discovered.projectKey;
  }

  throw new CommandFailedError('Could not determine project key.', {
    remediationHint:
      "Use --project <key>, or run 'sonar link <projectKey>' to link one to this repository.",
  });
}

export function assertSingleLineProjectKey(projectKey: string): void {
  if (!/[\r\n]/.test(projectKey)) {
    return;
  }
  throw new CommandFailedError('The project key must be a single line.', {
    exitCode: 2,
    remediationHint: 'Use --project <key> with a single-line project key.',
  });
}

function printSharedProjectConfigMapping(
  mapping: CompleteProjectMapping,
  options: DiscoverProjectOptions,
): void {
  if (options.silent) {
    return;
  }
  const fields = formatConfigFields(mapping.serverUrl, mapping.projectKey, mapping.organization);
  if (fields) {
    options.console.print(`Found ${SHARED_PROJECT_CONFIG_SOURCE}: ${fields}`);
  }
}

/** Walks lookupPaths nearest-first for the first `.sonar-config.json` found; it always applies — one file holds its mapping(s), so there's no "found but doesn't match" case. */
async function resolveSharedProjectConfigMappings(
  lookupPaths: LookupPath[],
  options: DiscoverProjectOptions,
): Promise<CompleteProjectMapping[] | null> {
  for (const { checkPath } of lookupPaths) {
    let mappings: SharedProjectConfigMapping[];
    try {
      mappings = await sharedProjectConfigRepository.load(checkPath);
    } catch (error) {
      logger.debug(
        `Shared project config lookup skipped for ${checkPath}: ${(error as Error).message}`,
      );
      continue;
    }
    if (mappings.length === 0) {
      continue;
    }

    for (const mapping of mappings) {
      printSharedProjectConfigMapping(mapping, options);
    }
    return mappings;
  }

  return null;
}

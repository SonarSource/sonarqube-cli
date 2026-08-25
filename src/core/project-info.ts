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

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { resolveAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import { findGitRoot, getGitRemote } from '@/core/host/git/discover.ts';
import { type LookupPath, resolveLookupPaths } from '@/core/host/git/lookup-path-resolver.ts';
import { resolveMainWorktreeRoot } from '@/core/host/git/worktree.ts';
import {
  type FeatureMatch,
  type RecordedFeatureCandidate,
  selectFeatureForLookupPaths,
} from '@/core/host/recorded-feature-resolver.ts';
import {
  buildKnownServerProjectMappings,
  type KnownServerProjectMapping,
} from '@/core/known-server-project-mappings.ts';
import {
  discoverProjectKeyByGitRemote,
  GIT_REMOTE_BINDING_SOURCE,
} from '@/core/server/discover-project-by-remote.ts';
import type { CliState } from '@/core/state/state.ts';
import { getActiveConnection } from '@/core/state/state-manager.ts';
import { loadState } from '@/core/state/state-repository.ts';
import { print } from '@/core/ui';

import { loadSonarLintConfig, type SonarLintConfig } from './host/sonarlint-connected-mode.ts';
import { canonicalizePath } from './io/fs-utils.ts';
import logger from './observability/logger.ts';

export const KNOWN_SERVER_PROJECT_MAPPING_SOURCE = 'known project mapping';

/** Local config files found at exactly one directory — no git, no root resolution. */
interface LocalProjectConfig {
  hasSonarProps: boolean;
  sonarPropsData: SonarProperties | null;
  hasSonarLintConfig: boolean;
  sonarLintData: SonarLintConfig | null;
  /** Relative path from project root, e.g. `.sonarlint/connectedMode.json` or `.sonarlint/MySolution.json` */
  sonarLintConfigPath: string | null;
}

export interface DiscoveredProject {
  /** Where the discovered project is anchored — what nearly every caller should use. */
  projectRoot: string;
  projectKey?: string;
  serverUrl?: string;
  organization?: string;
  /** Current git worktree root, or undefined outside git. Not a stand-in for `projectRoot` — a monorepo's project is routinely a subdirectory of the repo. */
  repoRoot?: string;
  /** The repository's main working tree, or undefined outside git — same regardless of which worktree resolved it. */
  mainRepoRoot?: string;
  /** Where `sonar integrate` was run for the matched mapping/feature (its own `targetRoot`), possibly a different worktree; undefined when nothing in state matched. */
  integrationDir?: string;
  /** Config files that contributed to the discovered project, in order found. */
  configSources: string[];
}

export interface DiscoverProjectOptions {
  /** When set, used for git-remote binding lookup instead of resolving auth again. */
  auth?: ResolvedAuth | null;
  /** When false, skips server lookup even if a git remote is present. Defaults to true. */
  tryGitRemoteBinding?: boolean;
}

export interface SonarProperties {
  hostURL: string;
  projectKey: string;
  projectName: string;
  organization: string;
}

/** Same nearest-first climb as discoverProject()'s local-config source — no known-mapping table, no git-remote API call, since this also runs pre-login (no token yet). */
async function discoverLocalConfig(
  startDir: string,
  silent: boolean,
): Promise<Pick<DiscoveredProject, 'serverUrl' | 'organization'>> {
  const config: DiscoveredProject = { projectRoot: canonicalizePath(startDir), configSources: [] };
  const lookupPaths = await resolveLookupPaths(startDir);
  await applyLocalConfigAcrossLookupPaths(config, lookupPaths, silent);
  return config;
}

/** Try to find server URL from project configs. */
export async function discoverServer(): Promise<string | null> {
  try {
    const { serverUrl } = await discoverLocalConfig(process.cwd(), false);
    return serverUrl ?? null;
  } catch (error) {
    logger.debug(`Error finding server in configs: ${(error as Error).message}`);
    return null;
  }
}

/** Try to find organization from project configs. */
export async function discoverOrganization(): Promise<string | null> {
  try {
    const { organization } = await discoverLocalConfig(process.cwd(), true);
    return organization ?? null;
  } catch {
    return null;
  }
}

/** Loads sonar-project.properties/.sonarlint from exactly `dir` — no git, no root resolution. */
async function loadLocalProjectConfig(dir: string): Promise<LocalProjectConfig> {
  const sonarProps = await loadSonarProperties(dir);
  const sonarLintLoaded = await loadSonarLintConfig(dir);

  return {
    hasSonarProps: sonarProps !== null,
    sonarPropsData: sonarProps,
    hasSonarLintConfig: sonarLintLoaded !== null,
    sonarLintData: sonarLintLoaded?.config ?? null,
    sonarLintConfigPath: sonarLintLoaded?.relativePath ?? null,
  };
}

/**
 * Tries each source in turn — known-server-project-mapping, then local config files, then
 * git-remote binding (a single repo-level last resort) — with the first two walking the
 * same nearest-first `resolveLookupPaths` list, so "closer wins" uniformly.
 */
export async function discoverProject(
  startDir: string,
  silent = false,
  options: DiscoverProjectOptions = {},
): Promise<DiscoveredProject> {
  const invocationDir = canonicalizePath(startDir);
  const config: DiscoveredProject = {
    projectRoot: invocationDir, // stay in place unless a source below resolves something more specific
    configSources: [],
  };

  try {
    const { gitRoot, isGit } = findGitRoot(startDir);
    const repoRoot = isGit ? canonicalizePath(gitRoot) : undefined;
    config.repoRoot = repoRoot;

    const lookupPaths = await resolveLookupPaths(startDir);
    logger.debug(
      `Project discovery lookup paths (nearest first): ${lookupPaths.map((p) => p.checkPath).join(', ')}`,
    );

    // Cache hit, not a second spawn: resolveLookupPaths() already resolved this above.
    config.mainRepoRoot = isGit
      ? ((await resolveMainWorktreeRoot(invocationDir)) ?? repoRoot)
      : undefined;

    const resolved =
      applyKnownServerProjectMapping(config, lookupPaths, silent, options.auth) ||
      (await applyLocalConfigAcrossLookupPaths(config, lookupPaths, silent));

    if (!resolved) {
      const gitRemote = repoRoot ? await getGitRemote(repoRoot) : '';
      await applyGitRemoteBindingFromRemote(config, gitRemote, options, silent);
    }
  } catch (error) {
    // No caller treats this as fallible — degrade to whatever was already resolved
    // rather than throwing out of a git hook, agent hook, or long-running MCP server.
    logger.debug(`Project discovery failed, returning partial result: ${(error as Error).message}`);
  }

  return config;
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
  silent = false,
): Promise<string> {
  if (explicitProject) {
    if (!silent) {
      print(`     Using project key: ${explicitProject}`, 'stderr');
    }
    return explicitProject;
  }

  const discovered = await discoverProject(process.cwd(), true, { auth });
  if (discovered.projectKey) {
    if (!silent) {
      print(`     Using auto-detected project key: ${discovered.projectKey}`, 'stderr');
    }
    return discovered.projectKey;
  }

  throw new CommandFailedError('Could not determine project key.', {
    remediationHint:
      'Use --project <key>, add sonar.projectKey to sonar-project.properties, or configure a .sonarlint/ binding.',
  });
}

function applyLocalSonarProperties(
  config: DiscoveredProject,
  local: LocalProjectConfig,
  silent: boolean,
): void {
  if (!local.hasSonarProps || !local.sonarPropsData) {
    return;
  }

  config.configSources.push('sonar-project.properties');
  config.serverUrl = local.sonarPropsData.hostURL;
  config.projectKey = local.sonarPropsData.projectKey;
  config.organization = local.sonarPropsData.organization;

  if (silent) {
    return;
  }
  const fields = formatConfigFields(config.serverUrl, config.projectKey, config.organization);
  if (fields) {
    print(`Found sonar-project.properties: ${fields}`);
  }
}

/** Returns true once `config.projectKey` is resolved, so the caller can stop checking further sources. */
function applySonarLintConfig(
  config: DiscoveredProject,
  local: LocalProjectConfig,
  silent: boolean,
): boolean {
  if (!local.hasSonarLintConfig || !local.sonarLintData || !local.sonarLintConfigPath) {
    return !!config.projectKey;
  }

  config.configSources.push(local.sonarLintConfigPath);
  config.serverUrl = config.serverUrl || local.sonarLintData.serverURL;
  config.projectKey = config.projectKey || local.sonarLintData.projectKey;
  config.organization = config.organization || local.sonarLintData.organization;

  if (!silent) {
    const fields = formatConfigFields(
      local.sonarLintData.serverURL,
      local.sonarLintData.projectKey,
      local.sonarLintData.organization,
    );
    if (fields) {
      print(`Found ${local.sonarLintConfigPath}: ${fields}`);
    }
  }

  return !!config.projectKey;
}

/** Walks `lookupPaths` nearest-first for a `sonar-project.properties`/`.sonarlint` hit; a partial match doesn't stop the climb. */
async function applyLocalConfigAcrossLookupPaths(
  config: DiscoveredProject,
  lookupPaths: LookupPath[],
  silent: boolean,
): Promise<boolean> {
  for (const { checkPath, projectRoot } of lookupPaths) {
    let local: LocalProjectConfig;
    try {
      local = await loadLocalProjectConfig(checkPath);
    } catch (error) {
      // e.g. EACCES on a directory further up the climb — don't let one unreadable
      // path abort discovery for the whole call, same as the other two sources.
      logger.debug(`Local config lookup skipped for ${checkPath}: ${(error as Error).message}`);
      continue;
    }
    if (!local.hasSonarProps && !local.hasSonarLintConfig) {
      continue;
    }

    applyLocalSonarProperties(config, local, silent);
    if (applySonarLintConfig(config, local, silent)) {
      config.projectRoot = projectRoot;
      return true;
    }
  }

  return false;
}

function matchKnownServerProjectMapping(
  lookupPaths: LookupPath[],
  mappings: KnownServerProjectMapping[],
): FeatureMatch<KnownServerProjectMapping> | undefined {
  if (mappings.length === 0) {
    return undefined;
  }

  const candidates: RecordedFeatureCandidate<KnownServerProjectMapping>[] = mappings.map(
    (mapping) => ({
      feature: mapping,
      targetRoot: mapping.targetRoot,
      repoRoot: mapping.repoRoot,
      updatedAt: mapping.updatedAt,
    }),
  );

  return selectFeatureForLookupPaths(candidates, lookupPaths);
}

/** Prefers the caller's own resolved auth over state, so per-invocation env-var auth resolves correctly even if it hasn't been persisted yet. */
function resolveMappingConnection(
  mapping: KnownServerProjectMapping,
  state: CliState,
  auth?: ResolvedAuth | null,
): { serverUrl: string | undefined; orgKey: string | undefined } {
  if (mapping.serverUrl) {
    return { serverUrl: mapping.serverUrl, orgKey: mapping.orgKey };
  }
  if (auth) {
    return { serverUrl: auth.serverUrl, orgKey: auth.orgKey };
  }
  const activeConnection = getActiveConnection(state);
  return { serverUrl: activeConnection?.serverUrl, orgKey: activeConnection?.orgKey };
}

/** Derives mappings live from installed features, then matches once so the nearest wins. */
function applyKnownServerProjectMapping(
  config: DiscoveredProject,
  lookupPaths: LookupPath[],
  silent: boolean,
  auth?: ResolvedAuth | null,
): boolean {
  let state: CliState;
  try {
    state = loadState();
  } catch (error) {
    logger.debug(`Known project mapping lookup skipped: ${(error as Error).message}`);
    return false;
  }

  const mappings = buildKnownServerProjectMappings(state);
  const match = matchKnownServerProjectMapping(lookupPaths, mappings);
  if (!match) {
    return false;
  }

  const { serverUrl, orgKey } = resolveMappingConnection(match.feature, state, auth);
  if (!serverUrl) {
    return false;
  }

  config.configSources.push(KNOWN_SERVER_PROJECT_MAPPING_SOURCE);
  config.projectKey = match.feature.projectKey;
  config.serverUrl = serverUrl;
  config.organization = orgKey;
  config.projectRoot = match.matchedPath;
  config.integrationDir = match.feature.targetRoot;

  if (!silent) {
    const fields = formatConfigFields(config.serverUrl, config.projectKey, config.organization);
    if (fields) {
      print(`Found ${KNOWN_SERVER_PROJECT_MAPPING_SOURCE}: ${fields}`);
    }
  }

  return true;
}

async function applyGitRemoteBindingFromRemote(
  config: DiscoveredProject,
  gitRemote: string,
  options: DiscoverProjectOptions,
  silent: boolean,
): Promise<void> {
  const tryGitRemoteBinding = options.tryGitRemoteBinding !== false;
  if (!tryGitRemoteBinding || !gitRemote) {
    return;
  }

  const auth = options.auth === undefined ? await resolveAuth() : options.auth;
  if (!auth) {
    return;
  }

  const remoteBinding = await discoverProjectKeyByGitRemote(auth, gitRemote);
  if (!remoteBinding) {
    return;
  }

  config.configSources.push(GIT_REMOTE_BINDING_SOURCE);
  config.serverUrl = config.serverUrl || remoteBinding.serverUrl;
  config.projectKey = remoteBinding.projectKey;
  config.organization = config.organization || remoteBinding.organization;

  if (silent) {
    return;
  }

  const fields = formatConfigFields(config.serverUrl, config.projectKey, config.organization);
  if (fields) {
    print(`Found ${GIT_REMOTE_BINDING_SOURCE}: ${fields}`);
  }
}

function formatConfigFields(
  serverUrl?: string,
  projectKey?: string,
  organization?: string,
): string {
  return Object.entries({ project: projectKey, server: serverUrl, org: organization })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

function parsePropertyLine(line: string, props: Partial<SonarProperties>): void {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith('#')) {
    return;
  }

  // Split only on the first '=' to allow '=' in values
  const eqIndex = trimmed.indexOf('=');
  if (eqIndex === -1) {
    return;
  }

  const key = trimmed.slice(0, eqIndex).trim();
  const value = trimmed.slice(eqIndex + 1).trim();

  const propertyMap: Record<string, keyof SonarProperties> = {
    'sonar.host.url': 'hostURL',
    'sonar.projectKey': 'projectKey',
    'sonar.projectName': 'projectName',
    'sonar.organization': 'organization',
  };

  if (key in propertyMap) {
    props[propertyMap[key]] = value;
  }
}

async function loadSonarProperties(projectRoot: string): Promise<SonarProperties | null> {
  const propPath = join(projectRoot, 'sonar-project.properties');

  if (!existsSync(propPath)) {
    return null;
  }

  const fs = await import('node:fs/promises');
  const content = await fs.readFile(propPath, 'utf-8');

  const props: Partial<SonarProperties> = {};

  for (const line of content.split('\n')) {
    parsePropertyLine(line, props);
  }

  if (!props.hostURL && !props.projectKey) {
    return null;
  }

  return props as SonarProperties;
}

export { type SonarLintConfig } from './host/sonarlint-connected-mode.ts';

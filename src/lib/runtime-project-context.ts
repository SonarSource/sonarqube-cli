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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { SQAA_HOOK_FEATURE_ID } from '../cli/commands/integrate/_common/sqaa-entitlement';
import { CLAUDE_INTEGRATION_ID } from '../cli/commands/integrate/claude/declaration';
import type { ResolvedAuth } from './auth-resolver';
import { resolveAuth } from './auth-resolver';
import { RUNTIME_PROJECT_CACHE_FILE } from './config-constants';
import logger from './logger';
import { spawnProcess } from './process';
import { discoverProject, findGitRoot, serverUrlsMatch } from './project-workspace/project-info';
import { loadState } from './repository/state-repository';
import { canonicalProjectRoot } from './state-manager';

const POSITIVE_CACHE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type RuntimeProjectSource = 'properties' | 'sonarlint' | 'git-remote' | 'state';

interface RuntimeProjectCacheEntry {
  gitRoot: string;
  projectKey?: string;
  source?: RuntimeProjectSource;
  serverUrl?: string;
  resolvedAt: string;
  expiresAt: string;
}

interface RuntimeProjectCacheFile {
  entries: RuntimeProjectCacheEntry[];
}

function loadCacheFile(): RuntimeProjectCacheFile {
  try {
    const raw = readFileSync(RUNTIME_PROJECT_CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as RuntimeProjectCacheFile;
    if (!Array.isArray(parsed.entries)) {
      return { entries: [] };
    }
    return parsed;
  } catch {
    return { entries: [] };
  }
}

function saveCacheFile(cache: RuntimeProjectCacheFile): void {
  mkdirSync(dirname(RUNTIME_PROJECT_CACHE_FILE), { recursive: true });
  writeFileSync(RUNTIME_PROJECT_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

function readCacheEntry(gitRoot: string): RuntimeProjectCacheEntry | null {
  const now = Date.now();
  const cache = loadCacheFile();
  const entry = cache.entries.find((candidate) => candidate.gitRoot === gitRoot);
  if (!entry) {
    return null;
  }
  if (Date.parse(entry.expiresAt) <= now) {
    cache.entries = cache.entries.filter((candidate) => candidate.gitRoot !== gitRoot);
    saveCacheFile(cache);
    return null;
  }
  return entry;
}

function writeCacheEntry(entry: RuntimeProjectCacheEntry): void {
  const cache = loadCacheFile();
  cache.entries = cache.entries.filter((candidate) => candidate.gitRoot !== entry.gitRoot);
  cache.entries.push(entry);
  saveCacheFile(cache);
}

function invalidateCacheEntry(gitRoot: string): void {
  const cache = loadCacheFile();
  cache.entries = cache.entries.filter((candidate) => candidate.gitRoot !== gitRoot);
  saveCacheFile(cache);
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  const { gitRoot, isGit } = findGitRoot(cwd);
  if (isGit) {
    return canonicalProjectRoot(gitRoot);
  }
  try {
    const result = await spawnProcess('git', ['rev-parse', '--show-toplevel'], { cwd });
    if (result.exitCode === 0) {
      return canonicalProjectRoot(resolve(result.stdout.trim()));
    }
  } catch {
    // git unavailable — fall through.
  }
  return canonicalProjectRoot(cwd);
}

function resolveProjectKeyFromIntegrationState(gitRoot: string): string | null {
  try {
    const state = loadState();
    const claude = state.integrations.installed.find(
      (integration) => integration.integrationId === CLAUDE_INTEGRATION_ID,
    );
    const sqaaFeature = claude?.features.find(
      (feature) =>
        feature.featureId === SQAA_HOOK_FEATURE_ID &&
        feature.scope === 'project' &&
        canonicalProjectRoot(feature.targetRoot) === gitRoot,
    );
    const projectKey = sqaaFeature?.attrs?.projectKey;
    return typeof projectKey === 'string' && projectKey.length > 0 ? projectKey : null;
  } catch {
    return null;
  }
}

function inferSource(
  projectKey: string,
  discovered: Awaited<ReturnType<typeof discoverProject>>,
): RuntimeProjectSource {
  if (discovered.projectKey === projectKey) {
    if (discovered.configSources.some((source) => source.includes('sonar-project.properties'))) {
      return 'properties';
    }
    if (discovered.configSources.some((source) => source.includes('.sonarlint'))) {
      return 'sonarlint';
    }
    if (discovered.configSources.some((source) => source.includes('git-remote'))) {
      return 'git-remote';
    }
  }
  return 'state';
}

/**
 * Resolve a SonarQube project key for the workspace at `cwd`.
 *
 * Order: explicit override (caller) → disk cache → discoverProject → integration state fallback.
 */
export async function resolveRuntimeProjectKey(
  cwd: string = process.cwd(),
  auth?: ResolvedAuth | null,
): Promise<string | null> {
  const resolvedAuth = auth ?? (await resolveAuth().catch(() => null));
  if (!resolvedAuth) {
    return null;
  }

  const gitRoot = await resolveRepoRoot(cwd);
  const cached = readCacheEntry(gitRoot);
  if (cached) {
    if (!cached.projectKey) {
      logger.debug('Runtime project resolution: negative cache hit');
      return null;
    }
    if (cached.serverUrl && serverUrlsMatch(cached.serverUrl, resolvedAuth.serverUrl)) {
      logger.debug(`Runtime project resolution: cache hit (${cached.projectKey})`);
      return cached.projectKey;
    }
    logger.debug('Runtime project resolution: cache invalidated (missing or mismatched server)');
    invalidateCacheEntry(gitRoot);
  }

  const discovered = await discoverProject(gitRoot, true, { auth: resolvedAuth });
  if (discovered.projectKey) {
    const source = inferSource(discovered.projectKey, discovered);
    writeCacheEntry({
      gitRoot,
      projectKey: discovered.projectKey,
      source,
      serverUrl: discovered.serverUrl ?? resolvedAuth.serverUrl,
      resolvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + POSITIVE_CACHE_TTL_MS).toISOString(),
    });
    return discovered.projectKey;
  }

  const stateKey = resolveProjectKeyFromIntegrationState(gitRoot);
  if (stateKey) {
    writeCacheEntry({
      gitRoot,
      projectKey: stateKey,
      source: 'state',
      serverUrl: resolvedAuth.serverUrl,
      resolvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + POSITIVE_CACHE_TTL_MS).toISOString(),
    });
    return stateKey;
  }

  writeCacheEntry({
    gitRoot,
    resolvedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + NEGATIVE_CACHE_TTL_MS).toISOString(),
  });
  logger.debug('Runtime project resolution: no Sonar project configured');
  return null;
}

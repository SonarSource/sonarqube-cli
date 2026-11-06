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

// Resolves SonarQube's legacy internal project identifier (`projects.uuid` — NOT a real
// RFC-4122 UUID) for the `project_uuid` telemetry field. Mirrors telemetry/identity.ts's
// cache-then-API shape, but keyed by server + project key rather than by connection
// fingerprint, since the legacy project id is a property of the project, not the caller.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { runWithConcurrencyLimit } from '@/core/concurrency/concurrency-pool.ts';
import { ComponentsClient } from '@/core/server/components.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import { getTelemetryDir } from '../config-constants.ts';
import { isTelemetryEnabled } from './enabled.ts';

const CACHE_FILENAME = 'project-uuid-cache.json';

/**
 * Transport-level budget for each project's resolution, passed to
 * `ComponentsClient.getComponentId()`. Deliberately far below the default GET timeout (30s):
 * this runs in the `postAction` hook, after the command has already printed its result, so a
 * slow server would otherwise look like the CLI hanging at exit (worst for
 * `hook git-pre-commit`, where it would stall a commit). Enforced via the fetch's own
 * `AbortSignal` rather than a `Promise.race`: racing only caps what we *await*, and an open
 * socket keeps the process alive regardless. Only ever bites on the first run for a given
 * project; every later run hits the permanent disk cache.
 */
const RESOLVE_BUDGET_MS = 3_000;

const RESOLVE_CONCURRENCY = 8;

/**
 * The cache file is user-writable JSON, so entry *values* are as untrusted as the envelope:
 * `unknown`, not `string | null`. Typing them honestly is what forces {@link readCachedUuid}
 * to narrow — a `Record<string, string | null>` would let a cast smuggle an arbitrary JSON
 * value straight into the `project_uuid` column.
 */
interface ProjectUuidCacheFile {
  entries: Record<string, unknown>;
}

function cacheKey(serverUrl: string, projectKey: string): string {
  return `${serverUrl}::${projectKey}`;
}

function readDiskCache(): ProjectUuidCacheFile {
  const path = join(getTelemetryDir(), CACHE_FILENAME);
  if (!existsSync(path)) {
    return { entries: {} };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed !== null && typeof parsed === 'object' && 'entries' in parsed) {
      // `entries` is untyped at runtime: guard against `null` (typeof null ===
      // 'object') and non-object values so callers can safely index into it.
      const entries: unknown = parsed.entries;
      if (entries !== null && typeof entries === 'object') {
        return parsed as ProjectUuidCacheFile;
      }
    }
  } catch {
    return { entries: {} };
  }
  return { entries: {} };
}

/**
 * Reads one cache entry, distinguishing three states:
 * - `{ hit: true, value }` — a usable `string` (resolved) or `null` (confirmed absent; stop
 *   retrying).
 * - `{ hit: false }` — key missing (never attempted), or present with a value that is neither
 *   a string nor `null`. A corrupt or hand-edited entry is therefore treated as "not yet
 *   attempted" and re-fetched, which also overwrites it with a valid value.
 */
function readCachedUuid(
  entries: Record<string, unknown>,
  entryKey: string,
): { hit: true; value: string | null } | { hit: false } {
  const cached = entries[entryKey];
  if (cached === null || typeof cached === 'string') {
    return { hit: true, value: cached };
  }
  return { hit: false };
}

function writeDiskCache(cache: ProjectUuidCacheFile): void {
  try {
    mkdirSync(getTelemetryDir(), { recursive: true });
    writeFileSync(join(getTelemetryDir(), CACHE_FILENAME), JSON.stringify(cache));
  } catch {
    // Best-effort — read-only or ephemeral filesystems skip persistence.
  }
}

/**
 * Resolves SonarQube's legacy internal project identifier for `projectKey`, caching the
 * result permanently under `{SONAR_USER_HOME}/sonarqube-cli/telemetry/project-uuid-cache.json`.
 *
 * Never rejects — always resolves to `string | null`. Skips entirely (no cache lookup, no API
 * call) when telemetry is disabled.
 */
export async function resolveProjectUuid(
  auth: ResolvedAuth,
  projectKey: string,
): Promise<string | null> {
  const [uuid] = await resolveProjectUuids([{ auth, projectKey }]);
  return uuid;
}

/** One cache read and write per batch, so concurrent misses cannot drop each other's entries. */
export async function resolveProjectUuids(
  projects: readonly NotedProject[],
): Promise<(string | null)[]> {
  try {
    if (!isTelemetryEnabled()) return projects.map(() => null);

    const diskCache = readDiskCache();
    const uuids = projects.map(({ auth, projectKey }) => {
      const cached = readCachedUuid(diskCache.entries, cacheKey(auth.serverUrl, projectKey));
      return cached.hit ? cached.value : undefined;
    });
    const missingIndices = uuids.flatMap((uuid, index) => (uuid === undefined ? [index] : []));
    if (missingIndices.length === 0) return uuids.map((uuid) => uuid ?? null);

    const fetched = await runWithConcurrencyLimit(missingIndices, RESOLVE_CONCURRENCY, (index) =>
      fetchProjectUuid(projects[index]),
    );
    let cacheChanged = false;
    for (const { item: index, value } of fetched) {
      const uuid = value ?? null;
      uuids[index] = uuid;
      // Only a resolved id is cached. `Ok(null)` is a 404: the project doesn't exist *yet*, and
      // a later analysis commonly provisions it. So it retries on the next command instead of
      // pinning `null` into the permanent, TTL-less cache, same as every other failure. Each
      // attempt is bounded by RESOLVE_BUDGET_MS, so a persistently hanging server costs that
      // budget once per project-resolving command rather than once ever. That is accepted
      // instead of adding a negative TTL: every noteProject site already makes its own server
      // calls under the 30s GET budget (SQAA, SCA, entitlement checks), so in any state where
      // this hangs, the command is already paying an order of magnitude more. A TTL would trade
      // telemetry completeness (null for the whole TTL after the network recovers) for a
      // latency win that is noise next to that. Revisit if it shows up in practice.
      if (uuid !== null) {
        const { auth, projectKey } = projects[index];
        diskCache.entries[cacheKey(auth.serverUrl, projectKey)] = uuid;
        cacheChanged = true;
      }
    }
    if (cacheChanged) writeDiskCache(diskCache);
    return uuids.map((uuid) => uuid ?? null);
  } catch {
    return projects.map(() => null);
  }
}

async function fetchProjectUuid({ auth, projectKey }: NotedProject): Promise<string | null> {
  const client = new SonarHttpClient(auth.serverUrl, auth.token);
  const result = await new ComponentsClient(client).getComponentId(projectKey, RESOLVE_BUDGET_MS);
  return result.isOk() ? result.value : null;
}

// --- Ambient per-invocation target projects ------------------------------------------------

export interface NotedProject {
  auth: ResolvedAuth;
  projectKey: string;
}

export interface TelemetryTargetProject extends NotedProject {
  projectUuid: string | null;
}

const notedProjects = new Map<string, NotedProject>();
let pendingTargetProjects: Promise<TelemetryTargetProject[]> | null = null;

function targetProjectKey(auth: ResolvedAuth, projectKey: string): string {
  return `${auth.serverUrl}::${auth.orgKey ?? ''}::${projectKey}`;
}

export function noteProject(auth: ResolvedAuth, projectKey: string | null | undefined): void {
  if (!projectKey) return;
  const key = targetProjectKey(auth, projectKey);
  if (notedProjects.has(key)) return;
  notedProjects.set(key, { auth, projectKey });
  pendingTargetProjects = null;
}

export function resolveTelemetryTargetProjects(): Promise<TelemetryTargetProject[]> {
  pendingTargetProjects ??= resolveTargetProjects([...notedProjects.values()]);
  return pendingTargetProjects;
}

async function resolveTargetProjects(projects: NotedProject[]): Promise<TelemetryTargetProject[]> {
  const uuids = await resolveProjectUuids(projects);
  return projects.map((project, index) => ({ ...project, projectUuid: uuids[index] }));
}

/**
 * Clear the ambient context. Tests **must** call this in `beforeEach`: module state outlives
 * individual tests in the same file, so a leaked project from an earlier test would otherwise
 * make a later assertion pass for the wrong reason.
 */
export function resetProjectUuidContextForTests(): void {
  notedProjects.clear();
  pendingTargetProjects = null;
}

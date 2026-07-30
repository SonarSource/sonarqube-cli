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
import { SonarQubeClient } from '@/core/server/client.ts';

import { getTelemetryDir } from '../config-constants.ts';
import { tryLoadState } from '../state/state-manager.ts';
import { isTelemetryEnabled } from './enabled.ts';

const CACHE_FILENAME = 'project-uuid-cache.json';

/**
 * Transport-level budget for the one resolution per process. Deliberately far below
 * `getSafe`'s 30s default: this runs in the `postAction` hook, after the command has already
 * printed its result, so a slow server would otherwise look like the CLI hanging at exit
 * (worst for `hook git-pre-commit`, where it would stall a commit). Enforced via the fetch's
 * own `AbortSignal` rather than a `Promise.race`, because racing only caps what we *await* —
 * an open socket keeps the process alive regardless. Only ever bites on the first run for a
 * given project; every later run hits the permanent disk cache.
 */
const RESOLVE_BUDGET_MS = 3_000;

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
 * Fetches the legacy project id from `/api/navigation/component`, end-to-end non-throwing.
 * Distinguishes a resolved-but-empty response (cache `null`, stop retrying) from a
 * transient/network failure (do not cache, retry next call) via the `ok` return flag.
 *
 * Deliberately does not reuse `SonarQubeClient.getComponentId()`: that helper collapses both
 * outcomes to `null`, which would defeat the cache's retry semantics.
 */
async function fetchProjectUuid(
  client: SonarQubeClient,
  projectKey: string,
): Promise<{ value: string | null; ok: boolean }> {
  try {
    const { response, value } = await client.getSafe<{ id: string }>(
      '/api/navigation/component',
      { component: projectKey },
      undefined,
      RESOLVE_BUDGET_MS,
    );
    if (!response.ok) {
      return { value: null, ok: false };
    }
    return { value: value?.id ?? null, ok: true };
  } catch {
    return { value: null, ok: false };
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
  try {
    const state = tryLoadState();
    if (!state || !isTelemetryEnabled(state)) return null;

    const entryKey = cacheKey(auth.serverUrl, projectKey);
    const diskCache = readDiskCache();
    const cached = readCachedUuid(diskCache.entries, entryKey);
    if (cached.hit) {
      return cached.value;
    }

    const client = new SonarQubeClient(auth.serverUrl, auth.token);
    const { value, ok } = await fetchProjectUuid(client, projectKey);
    if (ok) {
      diskCache.entries[entryKey] = value;
      writeDiskCache(diskCache);
    }
    // Transient failures are deliberately not cached, so the next command retries. Each
    // attempt is bounded by RESOLVE_BUDGET_MS, so a persistently hanging server costs that
    // budget once per project-resolving command rather than once ever. Accepted rather than
    // adding a negative TTL: every noteProject site sits on a path that already makes its own
    // server calls under the 30s GET budget (SQAA, SCA, entitlement checks), so in any state
    // where this hangs the command is already paying an order of magnitude more. A TTL would
    // trade telemetry completeness — null for the whole TTL after the network recovers — for a
    // latency win that is noise next to that. Revisit if it shows up in practice.
    return value;
  } catch {
    return null;
  }
}

// --- Ambient per-invocation project context -----------------------------------------------
//
// `project_uuid` is reported on `CliCommandExecuted` only; the other events are joined to it
// on the shared `invocation_id` that `buildIdentityBase` stamps on every event. That makes the
// project a per-process fact, so it is held here rather than threaded through call signatures
// (which previously required forwarding the Commander `Command` down ~12 function signatures
// purely to key a map that only ever held one entry). Same shape as `INVOCATION_ID` in
// invocation-id.ts: one value per CLI process.
//
// Commands that resolve a project key call `noteProject`; `storeEvent` calls
// `currentProjectUuid` once at `postAction`. Writes are synchronous and do no I/O, so noting
// never adds latency to the command's own work.

interface NotedProject {
  auth: ResolvedAuth;
  projectKey: string;
}

let notedProject: NotedProject | null = null;
let pendingResolution: Promise<string | null> | null = null;

/**
 * Record the project this invocation is about, for `project_uuid` on `CliCommandExecuted`.
 *
 * Synchronous and I/O-free — the API call happens later, once, in {@link currentProjectUuid}.
 * Call it at the point where both a project key and {@link ResolvedAuth} are known (auth is
 * needed for the server URL, and in the anonymous hook commands it is resolved inside the
 * handler, not before it). No-ops for a missing or empty key, so callers can pass an
 * unresolved value directly — that leaves `project_uuid: null`, which is the correct report
 * for `--global` installs and project-less commands.
 */
export function noteProject(auth: ResolvedAuth, projectKey: string | null | undefined): void {
  if (!projectKey) return;
  notedProject = { auth, projectKey };
  // Drop any memo from an earlier note so a superseding project key is not shadowed by it.
  pendingResolution = null;
}

/**
 * The `project_uuid` for this invocation, or `null` when no project was noted.
 *
 * Memoized: at most one resolution (and therefore at most one API call and one disk-cache
 * read) per process, however many times this is called.
 */
export function currentProjectUuid(): Promise<string | null> {
  const project = notedProject;
  if (!project) return Promise.resolve(null);
  pendingResolution ??= resolveProjectUuid(project.auth, project.projectKey);
  return pendingResolution;
}

/**
 * Clear the ambient context. Tests **must** call this in `beforeEach`: module state outlives
 * individual tests in the same file, so a leaked project from an earlier test would otherwise
 * make a later assertion pass for the wrong reason.
 */
export function resetProjectUuidContextForTests(): void {
  notedProject = null;
  pendingResolution = null;
}

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

/**
 * Unit tests for telemetry/project-uuid.ts: the cache-then-API resolver for the
 * `project_uuid` telemetry field. Every test uses a unique project key and an
 * isolated SONAR_USER_HOME to avoid cross-test disk-cache hits.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { ENV_SONAR_USER_HOME, getTelemetryDir } from '@/core/config-constants.ts';
import { ResultAsync } from '@/core/result.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import {
  noteProject,
  resetProjectUuidContextForTests,
  resolveProjectUuid,
  resolveTelemetryTargetProjects,
  type TelemetryTargetProject,
} from '@/core/telemetry/project-uuid.ts';

import { disableTelemetryInConfigFile } from '../../../_common/telemetry-helpers.ts';
import { mockProjectUuidGetSafe } from './project-uuid-api-mock.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function auth(overrides: Partial<ResolvedAuth> = {}): ResolvedAuth {
  return new ResolvedAuth({
    token: 't',
    serverUrl: 'https://sonarcloud.io',
    orgKey: 'my-org',
    connectionType: 'cloud',
    source: 'state' as const,
    ...overrides,
  });
}

/** Replicates project-uuid.ts#cacheKey so tests can seed the disk cache directly. */
function cacheKey(serverUrl: string, projectKey: string): string {
  return `${serverUrl}::${projectKey}`;
}

function seedDiskCache(serverUrl: string, projectKey: string, value: string | null): void {
  mkdirSync(getTelemetryDir(), { recursive: true });
  writeFileSync(
    join(getTelemetryDir(), 'project-uuid-cache.json'),
    JSON.stringify({ entries: { [cacheKey(serverUrl, projectKey)]: value } }),
  );
}

function writeRawCache(contents: string): void {
  mkdirSync(getTelemetryDir(), { recursive: true });
  writeFileSync(join(getTelemetryDir(), 'project-uuid-cache.json'), contents);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

let testDir: string;
let loadStateSpy: ReturnType<typeof spyOn>;
let savedDoNotTrack: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'project-uuid-test-'));
  process.env[ENV_SONAR_USER_HOME] = testDir;

  // The test preload opts every test out of telemetry via DO_NOT_TRACK=1 by default
  // (tests/_common/preload-isolated-env.ts) — clear it here to exercise the
  // telemetry-enabled path, matching telemetry-events.test.ts's convention.
  savedDoNotTrack = process.env.DO_NOT_TRACK;
  delete process.env.DO_NOT_TRACK;

  loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(getDefaultState('1.0.0'));

  // Mandatory: the ambient slot is module state, so it outlives individual tests in this
  // file. Without this a project noted by an earlier test would leak into a later one and
  // make its assertion pass for the wrong reason.
  resetProjectUuidContextForTests();
});

afterEach(() => {
  delete process.env[ENV_SONAR_USER_HOME];
  rmSync(testDir, { recursive: true, force: true });

  if (savedDoNotTrack !== undefined) {
    process.env.DO_NOT_TRACK = savedDoNotTrack;
  } else {
    delete process.env.DO_NOT_TRACK;
  }

  loadStateSpy.mockRestore();
});

// ─── resolveProjectUuid ─────────────────────────────────────────────────────

describe('resolveProjectUuid()', () => {
  it('serves a cached value from disk without hitting the API', async () => {
    seedDiskCache('https://sonarcloud.io', 'proj-disk-cached', 'AV-disk-cached');
    const getSafeSpy = mockProjectUuidGetSafe();

    const result = await resolveProjectUuid(auth(), 'proj-disk-cached');

    expect(result).toBe('AV-disk-cached');
    expect(getSafeSpy).not.toHaveBeenCalled();
    getSafeSpy.mockRestore();
  });

  it('resolves from the API on a cache miss and caches the result', async () => {
    const getSafeSpy = mockProjectUuidGetSafe({
      component: [{ ok: true, id: 'AV-fresh' }],
    });

    const first = await resolveProjectUuid(auth(), 'proj-cache-miss');
    const second = await resolveProjectUuid(auth(), 'proj-cache-miss');

    expect(first).toBe('AV-fresh');
    expect(second).toBe('AV-fresh');
    expect(getSafeSpy).toHaveBeenCalledTimes(1);
    getSafeSpy.mockRestore();
  });

  it('does not cache a 404 (project not created yet) and retries on the next call', async () => {
    const getSafeSpy = mockProjectUuidGetSafe({
      component: [
        { ok: false, status: 404 },
        { ok: true, id: 'AV-after-provisioning' },
      ],
    });

    const first = await resolveProjectUuid(auth(), 'proj-not-yet-provisioned');
    const second = await resolveProjectUuid(auth(), 'proj-not-yet-provisioned');

    expect(first).toBeNull();
    expect(second).toBe('AV-after-provisioning');
    expect(getSafeSpy).toHaveBeenCalledTimes(2);
    // RESOLVE_BUDGET_MS, forwarded through ComponentsClient.getComponentId() to getSafe's 3rd
    // argument, so this call keeps its tight budget instead of the default 30s GET timeout.
    expect(getSafeSpy.mock.calls[0]?.[2]).toBe(3_000);
    getSafeSpy.mockRestore();
  });

  it('does not cache a transient (non-ok) API failure and retries on the next call', async () => {
    const getSafeSpy = mockProjectUuidGetSafe({
      component: [{ ok: false }, { ok: true, id: 'AV-after-retry' }],
    });

    const first = await resolveProjectUuid(auth(), 'proj-transient-failure');
    const second = await resolveProjectUuid(auth(), 'proj-transient-failure');

    expect(first).toBeNull();
    expect(second).toBe('AV-after-retry');
    expect(getSafeSpy).toHaveBeenCalledTimes(2);
    getSafeSpy.mockRestore();
  });

  it('does not cache a network error (getSafe throws) and retries on the next call', async () => {
    const getSafeSpy = mockProjectUuidGetSafe({
      component: [
        { ok: false, throws: true },
        { ok: true, id: 'AV-after-network-retry' },
      ],
    });

    const first = await resolveProjectUuid(auth(), 'proj-network-error');
    const second = await resolveProjectUuid(auth(), 'proj-network-error');

    expect(first).toBeNull();
    expect(second).toBe('AV-after-network-retry');
    expect(getSafeSpy).toHaveBeenCalledTimes(2);
    getSafeSpy.mockRestore();
  });

  it('scopes the cache key by server URL, not just project key', async () => {
    seedDiskCache('https://sq.example.com', 'shared-key', 'AV-server-a');
    const getSafeSpy = mockProjectUuidGetSafe({
      component: [{ ok: true, id: 'AV-server-b' }],
    });

    const result = await resolveProjectUuid(
      auth({ serverUrl: 'https://other-server.example.com', connectionType: 'on-premise' }),
      'shared-key',
    );

    expect(result).toBe('AV-server-b');
    expect(getSafeSpy).toHaveBeenCalledTimes(1);
    getSafeSpy.mockRestore();
  });

  it('treats a malformed disk cache as empty and falls back to the API', async () => {
    writeRawCache('{ not valid json');
    const getSafeSpy = mockProjectUuidGetSafe({
      component: [{ ok: true, id: 'AV-after-malformed-cache' }],
    });

    const result = await resolveProjectUuid(auth(), 'proj-malformed-cache');

    expect(result).toBe('AV-after-malformed-cache');
    getSafeSpy.mockRestore();
  });

  it('treats a cache file without an entries object as empty', async () => {
    writeRawCache(JSON.stringify({ unexpected: true }));
    const getSafeSpy = mockProjectUuidGetSafe({
      component: [{ ok: true, id: 'AV-no-entries' }],
    });

    const result = await resolveProjectUuid(auth(), 'proj-no-entries');

    expect(result).toBe('AV-no-entries');
    getSafeSpy.mockRestore();
  });

  it('treats a cache file with a null entries value as empty', async () => {
    // `typeof null === 'object'`, so a null `entries` must be rejected explicitly;
    // otherwise indexing into it throws and degrades resolution to null forever.
    writeRawCache(JSON.stringify({ entries: null }));
    const getSafeSpy = mockProjectUuidGetSafe({
      component: [{ ok: true, id: 'AV-null-entries' }],
    });

    const result = await resolveProjectUuid(auth(), 'proj-null-entries');

    expect(result).toBe('AV-null-entries');
    getSafeSpy.mockRestore();
  });

  it.each([
    ['an object', { a: 1 }],
    ['a number', 42],
    ['a boolean', true],
    ['an array', ['x']],
  ])('re-fetches when a cached entry value is %s rather than a string', async (_label, bad) => {
    // Entry values are as untrusted as the envelope. Returning one unnarrowed would put a
    // non-string into the project_uuid column silently, with nothing to notice it by.
    const key = 'proj-corrupt-value';
    writeRawCache(JSON.stringify({ entries: { [cacheKey('https://sonarcloud.io', key)]: bad } }));
    const getSafeSpy = mockProjectUuidGetSafe({ component: [{ ok: true, id: 'AV-refetched' }] });

    const result = await resolveProjectUuid(auth(), key);

    // Corrupt entry treated as never-attempted: re-fetched, and the bad value overwritten.
    expect(result).toBe('AV-refetched');
    expect(getSafeSpy).toHaveBeenCalledTimes(1);
    expect(await resolveProjectUuid(auth(), key)).toBe('AV-refetched');
    expect(getSafeSpy).toHaveBeenCalledTimes(1);

    getSafeSpy.mockRestore();
  });

  it('skips the cache lookup and the API call entirely when telemetry is disabled', async () => {
    disableTelemetryInConfigFile();
    const getSafeSpy = mockProjectUuidGetSafe({
      component: [{ ok: true, id: 'AV-should-not-be-fetched' }],
    });

    const result = await resolveProjectUuid(auth(), 'proj-telemetry-disabled');

    expect(result).toBeNull();
    expect(getSafeSpy).not.toHaveBeenCalled();
    getSafeSpy.mockRestore();
  });

  it('never throws when the disk cache write fails (strictly best-effort)', async () => {
    const writeFileSyncSpy = spyOn(await import('node:fs'), 'writeFileSync').mockImplementation(
      () => {
        throw new Error('disk full');
      },
    );
    const getSafeSpy = mockProjectUuidGetSafe({
      component: [{ ok: true, id: 'AV-disk-full' }],
    });

    // Must resolve, not reject — a telemetry failure must never reach the command handler.
    const result = await resolveProjectUuid(auth(), 'proj-disk-full');

    expect(result).toBe('AV-disk-full');
    writeFileSyncSpy.mockRestore();
    getSafeSpy.mockRestore();
  });

  it('never throws when the API client itself throws unexpectedly', async () => {
    const getSafeSpy = spyOn(
      (await import('@/core/server/http-client.ts')).SonarHttpClient.prototype,
      'getSafe',
    ).mockImplementation(() => {
      throw new Error('synchronous failure before fetch');
    });

    const result = await resolveProjectUuid(auth(), 'proj-synchronous-throw');

    expect(result).toBeNull();
    getSafeSpy.mockRestore();
  });

  it('never throws when loading state itself throws', async () => {
    loadStateSpy.mockImplementation(() => {
      throw new Error('state file corrupted');
    });

    const result = await resolveProjectUuid(auth(), 'proj-state-throws');

    expect(result).toBeNull();
  });
});

// ─── Ambient per-invocation target projects ─────────────────────────────────────────

function projectUuids(targetProjects: TelemetryTargetProject[]): (string | null)[] {
  return targetProjects.map((targetProject) => targetProject.projectUuid);
}

describe('noteProject() / resolveTelemetryTargetProjects()', () => {
  it('resolves no target projects when no project was noted', async () => {
    const getSafeSpy = mockProjectUuidGetSafe();

    expect(await resolveTelemetryTargetProjects()).toEqual([]);
    expect(getSafeSpy).not.toHaveBeenCalled();

    getSafeSpy.mockRestore();
  });

  it('resolves the noted project via the API', async () => {
    const getSafeSpy = mockProjectUuidGetSafe({ component: [{ ok: true, id: 'AV-noted' }] });
    const noted = auth();

    noteProject(noted, 'proj-noted');

    const [targetProject] = await resolveTelemetryTargetProjects();
    expect(targetProject).toEqual({
      auth: noted,
      projectKey: 'proj-noted',
      projectUuid: 'AV-noted',
    });
    getSafeSpy.mockRestore();
  });

  it('memoizes: repeated reads make at most one API call per process', async () => {
    const getSafeSpy = mockProjectUuidGetSafe({ component: [{ ok: true, id: 'AV-memo' }] });

    noteProject(auth(), 'proj-memoized');

    expect(projectUuids(await resolveTelemetryTargetProjects())).toEqual(['AV-memo']);
    expect(projectUuids(await resolveTelemetryTargetProjects())).toEqual(['AV-memo']);
    expect(getSafeSpy).toHaveBeenCalledTimes(1);

    getSafeSpy.mockRestore();
  });

  it('ignores an empty or missing project key', async () => {
    const getSafeSpy = mockProjectUuidGetSafe();

    noteProject(auth(), undefined);
    noteProject(auth(), null);
    noteProject(auth(), '');

    expect(await resolveTelemetryTargetProjects()).toEqual([]);
    expect(getSafeSpy).not.toHaveBeenCalled();

    getSafeSpy.mockRestore();
  });

  it('keeps every distinct project in noting order and records a repeated one once', async () => {
    const getSafeSpy = mockProjectUuidGetSafe({
      idByProjectKey: { 'proj-a': 'AV-a', 'proj-b': 'AV-b' },
    });

    noteProject(auth(), 'proj-a');
    noteProject(auth(), 'proj-b');
    noteProject(auth(), 'proj-a');

    const targetProjects = await resolveTelemetryTargetProjects();
    expect(targetProjects.map((targetProject) => targetProject.projectKey)).toEqual([
      'proj-a',
      'proj-b',
    ]);
    expect(projectUuids(targetProjects)).toEqual(['AV-a', 'AV-b']);
    expect(getSafeSpy).toHaveBeenCalledTimes(2);

    getSafeSpy.mockRestore();
  });

  it('treats the same project key on another server as a separate target project', async () => {
    const getSafeSpy = mockProjectUuidGetSafe({ idByProjectKey: { 'proj-shared': 'AV-shared' } });
    const server = auth({ serverUrl: 'https://sq.example.com', orgKey: undefined });

    noteProject(auth(), 'proj-shared');
    noteProject(server, 'proj-shared');

    const targetProjects = await resolveTelemetryTargetProjects();
    expect(targetProjects.map((targetProject) => targetProject.auth.serverUrl)).toEqual([
      'https://sonarcloud.io',
      'https://sq.example.com',
    ]);

    getSafeSpy.mockRestore();
  });

  it('caches every project resolved in one batch', async () => {
    const getSafeSpy = mockProjectUuidGetSafe({
      idByProjectKey: { 'proj-batch-a': 'AV-batch-a', 'proj-batch-b': 'AV-batch-b' },
    });

    noteProject(auth(), 'proj-batch-a');
    noteProject(auth(), 'proj-batch-b');
    await resolveTelemetryTargetProjects();

    expect(await resolveProjectUuid(auth(), 'proj-batch-a')).toBe('AV-batch-a');
    expect(await resolveProjectUuid(auth(), 'proj-batch-b')).toBe('AV-batch-b');
    expect(getSafeSpy).toHaveBeenCalledTimes(2);

    getSafeSpy.mockRestore();
  });

  it('starts every lookup at once with the same budget, however many projects', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getSafeSpy = spyOn(SonarHttpClient.prototype, 'getSafe').mockImplementation(<TValue>() =>
      ResultAsync.fromSafePromise(
        released.then(() => ({
          response: { ok: true, status: 200 } as Response,
          value: {} as TValue,
        })),
      ),
    );
    const keys = Array.from({ length: 12 }, (_, index) => `proj-concurrent-${index}`);
    for (const key of keys) noteProject(auth(), key);

    const resolving = resolveTelemetryTargetProjects();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getSafeSpy).toHaveBeenCalledTimes(keys.length);
    expect(new Set(getSafeSpy.mock.calls.map((call) => call[2]))).toEqual(new Set([3_000]));

    release();
    await resolving;
    getSafeSpy.mockRestore();
  });

  it('re-resolves when a project is noted after an earlier read', async () => {
    const getSafeSpy = mockProjectUuidGetSafe({
      idByProjectKey: { 'proj-early': 'AV-early', 'proj-late': 'AV-late' },
    });

    noteProject(auth(), 'proj-early');
    expect(projectUuids(await resolveTelemetryTargetProjects())).toEqual(['AV-early']);
    noteProject(auth(), 'proj-late');

    expect(projectUuids(await resolveTelemetryTargetProjects())).toEqual(['AV-early', 'AV-late']);

    getSafeSpy.mockRestore();
  });

  it('never rejects when resolution fails, so command telemetry cannot be broken by it', async () => {
    const getSafeSpy = mockProjectUuidGetSafe({
      component: [{ ok: false, throws: true }],
    });

    noteProject(auth(), 'proj-explodes');

    expect(projectUuids(await resolveTelemetryTargetProjects())).toEqual([null]);
    getSafeSpy.mockRestore();
  });
});

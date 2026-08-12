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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import {
  FEATURE_FLAG_CACHE_TTL_MS,
  type FeatureFlagFetcher,
  type FeatureFlagIdentity,
  resolvePrivateBetaFlags,
} from '@/core/launch-darkly';
import * as featureFlagCache from '@/core/launch-darkly/cache.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateManager from '@/core/state/state-manager.ts';
import * as identityFetch from '@/core/telemetry/identity-fetch.ts';

import { version as VERSION } from '../../../../package.json';

const cloudAuth: ResolvedAuth = {
  connectionType: 'cloud',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'my-org',
  token: 'token',
};

const FLAG_KEYS = ['cli.beta.private'] as const;

describe('resolvePrivateBetaFlags', () => {
  let tempHome: string;
  let previousUserHome: string | undefined;
  let tryLoadStateSpy: ReturnType<typeof spyOn>;
  let resolveTelemetryIdentitySpy: ReturnType<typeof spyOn>;

  const cloudIdentity: FeatureFlagIdentity = {
    connectionType: 'cloud',
    userUuid: 'user-1',
    organizationUuidV4: 'org-1',
    sqsInstallationId: null,
  };

  const cliVersion = String(VERSION);

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'sqcli-launch-darkly-'));
    previousUserHome = process.env.SONAR_USER_HOME;
    process.env.SONAR_USER_HOME = tempHome;

    const state = getDefaultState(cliVersion);
    state.auth.isAuthenticated = true;
    state.auth.activeConnectionId = 'conn-1';
    state.auth.connections = [
      {
        id: 'conn-1',
        type: 'cloud',
        serverUrl: 'https://sonarcloud.io',
        orgKey: 'my-org',
        authenticatedAt: new Date().toISOString(),
        userUuid: 'user-1',
        organizationUuidV4: 'org-1',
      },
    ];
    tryLoadStateSpy = spyOn(stateManager, 'tryLoadState').mockReturnValue(state);
    resolveTelemetryIdentitySpy = spyOn(identityFetch, 'resolveTelemetryIdentity');
  });

  afterEach(() => {
    tryLoadStateSpy.mockRestore();
    resolveTelemetryIdentitySpy.mockRestore();
    if (previousUserHome === undefined) {
      delete process.env.SONAR_USER_HOME;
    } else {
      process.env.SONAR_USER_HOME = previousUserHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns an empty map when no flag keys are declared', async () => {
    const fetchFlags = mock(() =>
      Promise.resolve({ 'cli.beta.private': true }),
    ) as FeatureFlagFetcher;

    expect(
      await resolvePrivateBetaFlags(cloudAuth, {
        fetchFlags,
        flagKeys: [],
        clientSideId: 'client-id',
      }),
    ).toEqual({});
    expect(fetchFlags).not.toHaveBeenCalled();
  });

  it('returns an empty map when auth is missing', async () => {
    const fetchFlags = mock(() =>
      Promise.resolve({ 'cli.beta.private': true }),
    ) as FeatureFlagFetcher;

    expect(
      await resolvePrivateBetaFlags(null, {
        fetchFlags,
        flagKeys: FLAG_KEYS,
        clientSideId: 'client-id',
      }),
    ).toEqual({});
    expect(fetchFlags).not.toHaveBeenCalled();
  });

  it('returns fetched flag decisions for a complete identity', async () => {
    const fetchFlags = mock(() =>
      Promise.resolve({
        'cli.beta.private': true,
        'cli.beta.other': false,
      }),
    ) as FeatureFlagFetcher;

    expect(
      await resolvePrivateBetaFlags(cloudAuth, {
        fetchFlags,
        flagKeys: ['cli.beta.private', 'cli.beta.other'],
        clientSideId: 'client-id',
      }),
    ).toEqual({
      'cli.beta.private': true,
      'cli.beta.other': false,
    });
    expect(fetchFlags).toHaveBeenCalledTimes(1);
  });

  it('treats flags missing from the LaunchDarkly response as false and caches them', async () => {
    const fetchFlags = mock(() => Promise.resolve({})) as FeatureFlagFetcher;

    expect(
      await resolvePrivateBetaFlags(cloudAuth, {
        fetchFlags,
        flagKeys: FLAG_KEYS,
        clientSideId: 'client-id',
        nowMs: 1_000,
      }),
    ).toEqual({ 'cli.beta.private': false });
    expect(fetchFlags).toHaveBeenCalledTimes(1);

    expect(
      await resolvePrivateBetaFlags(cloudAuth, {
        fetchFlags,
        flagKeys: FLAG_KEYS,
        clientSideId: 'client-id',
        nowMs: 1_000 + FEATURE_FLAG_CACHE_TTL_MS - 1,
      }),
    ).toEqual({ 'cli.beta.private': false });
    expect(fetchFlags).toHaveBeenCalledTimes(1);
  });

  it('returns an empty map when the client-side ID is missing', async () => {
    const fetchFlags = mock(() =>
      Promise.resolve({ 'cli.beta.private': true }),
    ) as FeatureFlagFetcher;

    expect(
      await resolvePrivateBetaFlags(cloudAuth, {
        fetchFlags,
        flagKeys: FLAG_KEYS,
        clientSideId: '',
      }),
    ).toEqual({});
    expect(fetchFlags).not.toHaveBeenCalled();
  });

  it('returns an empty map when identity is incomplete', async () => {
    tryLoadStateSpy.mockReturnValue(getDefaultState(cliVersion));
    resolveTelemetryIdentitySpy.mockResolvedValue({
      user_uuid: null,
      organization_uuid_v4: null,
      sqs_installation_id: null,
    });
    const fetchFlags = mock(() =>
      Promise.resolve({ 'cli.beta.private': true }),
    ) as FeatureFlagFetcher;

    expect(
      await resolvePrivateBetaFlags(cloudAuth, {
        fetchFlags,
        flagKeys: FLAG_KEYS,
        clientSideId: 'client-id',
      }),
    ).toEqual({});
    expect(fetchFlags).not.toHaveBeenCalled();
  });

  it('enriches an incomplete connection identity before fetching flags', async () => {
    const state = getDefaultState(cliVersion);
    state.auth.isAuthenticated = true;
    state.auth.activeConnectionId = 'conn-1';
    state.auth.connections = [
      {
        id: 'conn-1',
        type: 'cloud',
        serverUrl: 'https://sonarcloud.io',
        orgKey: 'my-org',
        authenticatedAt: new Date().toISOString(),
      },
    ];
    tryLoadStateSpy.mockReturnValue(state);
    resolveTelemetryIdentitySpy.mockResolvedValue({
      user_uuid: 'user-1',
      organization_uuid_v4: 'org-1',
      sqs_installation_id: null,
    });
    const fetchFlags = mock(() =>
      Promise.resolve({ 'cli.beta.private': true }),
    ) as FeatureFlagFetcher;

    expect(
      await resolvePrivateBetaFlags(cloudAuth, {
        fetchFlags,
        flagKeys: FLAG_KEYS,
        clientSideId: 'client-id',
      }),
    ).toEqual({ 'cli.beta.private': true });
    expect(resolveTelemetryIdentitySpy).toHaveBeenCalled();
    expect(fetchFlags).toHaveBeenCalledTimes(1);
  });

  it('returns an empty map when the flag fetcher throws', async () => {
    const fetchFlags = mock(() => Promise.reject(new Error('network down'))) as FeatureFlagFetcher;

    expect(
      await resolvePrivateBetaFlags(cloudAuth, {
        fetchFlags,
        flagKeys: FLAG_KEYS,
        clientSideId: 'client-id',
      }),
    ).toEqual({});
  });

  it('uses the default client-side ID when omitted', async () => {
    const fetchFlags = mock(() =>
      Promise.resolve({ 'cli.beta.private': true }),
    ) as FeatureFlagFetcher;

    expect(
      await resolvePrivateBetaFlags(cloudAuth, {
        fetchFlags,
        flagKeys: FLAG_KEYS,
      }),
    ).toEqual({ 'cli.beta.private': true });
    expect(fetchFlags).toHaveBeenCalledTimes(1);
  });

  it('reuses a fresh cache entry without calling LaunchDarkly', async () => {
    featureFlagCache.writeFlagDecisions(
      cloudIdentity,
      { 'cli.beta.private': true },
      'client-id',
      1_000,
    );
    const fetchFlags = mock(() =>
      Promise.resolve({ 'cli.beta.private': false }),
    ) as FeatureFlagFetcher;

    expect(
      await resolvePrivateBetaFlags(cloudAuth, {
        fetchFlags,
        flagKeys: FLAG_KEYS,
        clientSideId: 'client-id',
        nowMs: 1_000 + FEATURE_FLAG_CACHE_TTL_MS - 1,
      }),
    ).toEqual({ 'cli.beta.private': true });
    expect(fetchFlags).not.toHaveBeenCalled();
  });

  it('refreshes after the cache TTL and does not reuse an expired true', async () => {
    featureFlagCache.writeFlagDecisions(
      cloudIdentity,
      { 'cli.beta.private': true },
      'client-id',
      1_000,
    );
    const fetchFlags = mock(() =>
      Promise.resolve({ 'cli.beta.private': false }),
    ) as FeatureFlagFetcher;

    expect(
      await resolvePrivateBetaFlags(cloudAuth, {
        fetchFlags,
        flagKeys: FLAG_KEYS,
        clientSideId: 'client-id',
        nowMs: 1_000 + FEATURE_FLAG_CACHE_TTL_MS,
      }),
    ).toEqual({ 'cli.beta.private': false });
    expect(fetchFlags).toHaveBeenCalledTimes(1);
  });

  it('drops cached entries when the client-side ID changes', async () => {
    featureFlagCache.writeFlagDecisions(
      cloudIdentity,
      { 'cli.beta.private': true },
      'old-client-id',
      1_000,
    );
    const fetchFlags = mock(() =>
      Promise.resolve({ 'cli.beta.private': false }),
    ) as FeatureFlagFetcher;

    expect(
      await resolvePrivateBetaFlags(cloudAuth, {
        fetchFlags,
        flagKeys: FLAG_KEYS,
        clientSideId: 'new-client-id',
        nowMs: 1_000 + FEATURE_FLAG_CACHE_TTL_MS - 1,
      }),
    ).toEqual({ 'cli.beta.private': false });
    expect(fetchFlags).toHaveBeenCalledTimes(1);
  });
});

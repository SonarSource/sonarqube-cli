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

import { createCommandTree } from '@/commands/command-tree.ts';
import * as sonarCommandModule from '@/commands/sonar-command.ts';
import {
  type CliRuntime,
  collectPrivateBetaFlagKeys,
  SonarCommand,
  SonarOption,
  Stage,
} from '@/commands/sonar-command.ts';
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

  it('does not cache a null fetch result so a later success can enable the flag', async () => {
    const fetchFlags = mock(
      (_identity: FeatureFlagIdentity): Promise<Record<string, boolean> | null> =>
        Promise.resolve(null),
    );

    expect(
      await resolvePrivateBetaFlags(cloudAuth, {
        fetchFlags,
        flagKeys: FLAG_KEYS,
        clientSideId: 'client-id',
        nowMs: 1_000,
      }),
    ).toEqual({});
    expect(fetchFlags).toHaveBeenCalledTimes(1);

    fetchFlags.mockImplementation(() => Promise.resolve({ 'cli.beta.private': true }));

    expect(
      await resolvePrivateBetaFlags(cloudAuth, {
        fetchFlags,
        flagKeys: FLAG_KEYS,
        clientSideId: 'client-id',
        nowMs: 1_000 + FEATURE_FLAG_CACHE_TTL_MS - 1,
      }),
    ).toEqual({ 'cli.beta.private': true });
    expect(fetchFlags).toHaveBeenCalledTimes(2);
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

describe('Private Beta command registration', () => {
  function runtimeWithFlags(flags: Record<string, boolean>): CliRuntime {
    return {
      auth: cloudAuth,
      isAlphaEnabled: false,
      isPrivateBetaEnabled: (flagKey) => flags[flagKey] === true,
    };
  }

  it('registers Private Beta commands only when the flag is enabled', () => {
    const enabled = new SonarCommand('sonar', {
      runtime: runtimeWithFlags({ 'cli.beta.private': true }),
    });
    enabled.command('stable').description('Stable command');
    enabled.command('open-beta').description('Open beta').stage(Stage.Beta());
    enabled
      .command('private-beta')
      .description('Private beta')
      .stage(Stage.Beta('cli.beta.private'));

    expect(enabled.commands.map((c) => c.name())).toEqual(['stable', 'open-beta', 'private-beta']);

    const denied = new SonarCommand('sonar', {
      runtime: runtimeWithFlags({ 'cli.beta.private': false }),
    });
    denied.command('stable').description('Stable command');
    denied.command('open-beta').description('Open beta').stage(Stage.Beta());
    denied
      .command('private-beta')
      .description('Private beta')
      .stage(Stage.Beta('cli.beta.private'));

    expect(denied.commands.map((c) => c.name())).toEqual(['stable', 'open-beta']);
  });

  it('omits Private Beta commands from createCommandTree by default', async () => {
    const tree = await createCommandTree();
    const names = tree.commands.map((c) => c.name());
    expect(names).toContain('context');
    // No Private Beta commands exist yet; default runtime omits gated ones.
    for (const command of tree.commands as SonarCommand[]) {
      expect(command.isPrivateBeta).toBe(false);
    }
  });

  it('does not call loadPrivateBetaContext when no Private Beta keys exist', async () => {
    const loadPrivateBetaContext = mock(() =>
      Promise.resolve({
        auth: null,
        flags: {},
      }),
    );

    await createCommandTree({ loadPrivateBetaContext });

    expect(loadPrivateBetaContext).not.toHaveBeenCalled();
  });

  it('calls loadPrivateBetaContext with discovered keys then rebuilds', async () => {
    const collectSpy = spyOn(sonarCommandModule, 'collectPrivateBetaFlagKeys').mockReturnValue([
      'cli.beta.lazy',
    ]);

    const loadPrivateBetaContext = mock((flagKeys: readonly string[]) => {
      expect([...flagKeys]).toEqual(['cli.beta.lazy']);
      return Promise.resolve({
        auth: cloudAuth,
        flags: { 'cli.beta.lazy': true },
      });
    });

    try {
      const tree = await createCommandTree({ loadPrivateBetaContext });
      expect(loadPrivateBetaContext).toHaveBeenCalledTimes(1);
      expect(tree.runtime.auth).toEqual(cloudAuth);
      expect(tree.runtime.isPrivateBetaEnabled('cli.beta.lazy')).toBe(true);
      expect(tree.runtime.isPrivateBetaEnabled('cli.beta.other')).toBe(false);
    } finally {
      collectSpy.mockRestore();
    }
  });

  it('collects Private Beta flag keys from Stage.Beta declarations', () => {
    const root = new SonarCommand('sonar', {
      runtime: {
        auth: null,
        isAlphaEnabled: false,
        isPrivateBetaEnabled: () => true,
      },
    });
    root.command('stable');
    root.command('open').stage(Stage.Beta());
    root.command('private-a').stage(Stage.Beta('cli.beta.a'));
    root.command('private-b').stage(Stage.Beta('cli.beta.b'));
    root.command('private-a-dup').stage(Stage.Beta('cli.beta.a'));
    root
      .command('with-option')
      .addOption(new SonarOption('--gated', 'Gated option').stage(Stage.Beta('cli.beta.option')));

    expect(collectPrivateBetaFlagKeys(root).sort()).toEqual([
      'cli.beta.a',
      'cli.beta.b',
      'cli.beta.option',
    ]);
  });
});

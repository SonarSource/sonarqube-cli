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

import { SonarCommand, Stage } from '@/commands/sonar-command.ts';
import * as authResolver from '@/core/auth/auth-resolver.ts';
import {
  FEATURE_FLAG_CACHE_TTL_MS,
  type FeatureFlagFetcher,
  type FeatureFlagIdentity,
} from '@/core/launch-darkly';
import * as featureFlagCache from '@/core/launch-darkly/cache.ts';
import { applyPrivateBetaGating } from '@/core/launch-darkly/private-beta.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateManager from '@/core/state/state-manager.ts';
import * as identityFetch from '@/core/telemetry/identity-fetch.ts';

import { version as VERSION } from '../../../../package.json';

describe('applyPrivateBetaGating', () => {
  let tempHome: string;
  let previousUserHome: string | undefined;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
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

    resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue({
      connectionType: 'cloud',
      serverUrl: 'https://sonarcloud.io',
      orgKey: 'my-org',
      token: 'token',
    });

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
    resolveAuthSpy.mockRestore();
    tryLoadStateSpy.mockRestore();
    resolveTelemetryIdentitySpy.mockRestore();
    if (previousUserHome === undefined) {
      delete process.env.SONAR_USER_HOME;
    } else {
      process.env.SONAR_USER_HOME = previousUserHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  function buildTree() {
    const root = new SonarCommand('sonar');
    root.command('stable').description('Stable command');
    root.command('open-beta').description('Open beta').stage(Stage.Beta());
    root.command('private-beta').description('Private beta').stage(Stage.Beta('cli.beta.private'));
    return root;
  }

  it('is a no-op when the tree has no Private Beta commands', async () => {
    const root = new SonarCommand('sonar');
    root.command('open-beta').stage(Stage.Beta());
    const fetchFlags = mock(() => Promise.resolve({})) as FeatureFlagFetcher;

    await applyPrivateBetaGating(root, { fetchFlags, clientSideId: 'client-id' });

    expect(fetchFlags).not.toHaveBeenCalled();
    expect(resolveAuthSpy).not.toHaveBeenCalled();
    expect(root.commands.map((c) => c.name())).toContain('open-beta');
  });

  it('keeps entitled Private Beta commands and removes denied ones', async () => {
    const root = buildTree();
    const fetchFlags = mock(() =>
      Promise.resolve({
        'cli.beta.private': true,
      }),
    ) as FeatureFlagFetcher;

    await applyPrivateBetaGating(root, { fetchFlags, clientSideId: 'client-id' });

    expect(root.commands.map((c) => c.name())).toEqual(['stable', 'open-beta', 'private-beta']);
    expect(fetchFlags).toHaveBeenCalledTimes(1);
  });

  it('removes Private Beta commands when the flag is false', async () => {
    const root = buildTree();
    const fetchFlags = mock(() =>
      Promise.resolve({
        'cli.beta.private': false,
      }),
    ) as FeatureFlagFetcher;

    await applyPrivateBetaGating(root, { fetchFlags, clientSideId: 'client-id' });

    expect(root.commands.map((c) => c.name())).toEqual(['stable', 'open-beta']);
  });

  it('treats missing auth as not entitled', async () => {
    resolveAuthSpy.mockResolvedValue(null);
    const root = buildTree();
    const fetchFlags = mock(() =>
      Promise.resolve({
        'cli.beta.private': true,
      }),
    ) as FeatureFlagFetcher;

    await applyPrivateBetaGating(root, { fetchFlags, clientSideId: 'client-id' });

    expect(root.commands.map((c) => c.name())).toEqual(['stable', 'open-beta']);
    expect(fetchFlags).not.toHaveBeenCalled();
  });

  it('treats a missing client-side ID as not entitled', async () => {
    const root = buildTree();
    const fetchFlags = mock(() =>
      Promise.resolve({
        'cli.beta.private': true,
      }),
    ) as FeatureFlagFetcher;

    await applyPrivateBetaGating(root, { fetchFlags, clientSideId: '' });

    expect(root.commands.map((c) => c.name())).toEqual(['stable', 'open-beta']);
    expect(fetchFlags).not.toHaveBeenCalled();
  });

  it('reuses a fresh cache entry without calling LaunchDarkly', async () => {
    featureFlagCache.writeFlagDecisions(
      cloudIdentity,
      { 'cli.beta.private': true },
      'client-id',
      1_000,
    );
    const root = buildTree();
    const fetchFlags = mock(() =>
      Promise.resolve({
        'cli.beta.private': false,
      }),
    ) as FeatureFlagFetcher;

    await applyPrivateBetaGating(root, {
      fetchFlags,
      clientSideId: 'client-id',
      nowMs: 1_000 + FEATURE_FLAG_CACHE_TTL_MS - 1,
    });

    expect(fetchFlags).not.toHaveBeenCalled();
    expect(root.commands.map((c) => c.name())).toContain('private-beta');
  });

  it('refreshes after the cache TTL and does not reuse an expired true', async () => {
    featureFlagCache.writeFlagDecisions(
      cloudIdentity,
      { 'cli.beta.private': true },
      'client-id',
      1_000,
    );
    const root = buildTree();
    const fetchFlags = mock(() =>
      Promise.resolve({
        'cli.beta.private': false,
      }),
    ) as FeatureFlagFetcher;

    await applyPrivateBetaGating(root, {
      fetchFlags,
      clientSideId: 'client-id',
      nowMs: 1_000 + FEATURE_FLAG_CACHE_TTL_MS,
    });

    expect(fetchFlags).toHaveBeenCalledTimes(1);
    expect(root.commands.map((c) => c.name())).toEqual(['stable', 'open-beta']);
  });
});

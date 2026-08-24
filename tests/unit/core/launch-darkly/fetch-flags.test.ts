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

import type { FeatureFlagIdentity } from '@/core/launch-darkly';
import * as ldConstants from '@/core/launch-darkly/constants.ts';

type LdClientLogger = {
  debug: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

const waitForInitialization = mock((_timeoutSeconds?: number) => Promise.resolve(undefined));
const allFlags = mock((): Record<string, unknown> => ({
  'cli.beta.private': true,
  'cli.beta.other': false,
  'cli.beta.stringy': 'yes',
}));
const close = mock(() => Promise.resolve(undefined));
const initialize = mock((_clientSideId: string, _context: unknown, _options: unknown) => ({
  waitForInitialization,
  allFlags,
  close,
}));

void mock.module('launchdarkly-node-client-sdk', () => ({
  initialize,
}));

const { fetchFlagsFromLaunchDarkly } = await import('@/core/launch-darkly');
const { getLaunchDarklyDir, LAUNCHDARKLY_INIT_TIMEOUT_SECONDS } =
  await import('@/core/launch-darkly/constants.ts');

const cloudIdentity: FeatureFlagIdentity = {
  connectionType: 'cloud',
  userUuid: 'user-1',
  organizationUuidV4: 'org-1',
  enterpriseUuid: null,
  sqsInstallationId: null,
};

describe('fetchFlagsFromLaunchDarkly', () => {
  let tempHome: string;
  let previousUserHome: string | undefined;
  let clientSideIdSpy: { mockRestore: () => void } | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'sqcli-ld-fetch-'));
    previousUserHome = process.env.SONAR_USER_HOME;
    process.env.SONAR_USER_HOME = tempHome;
    waitForInitialization.mockClear();
    waitForInitialization.mockImplementation(() => Promise.resolve(undefined));
    allFlags.mockClear();
    allFlags.mockImplementation(() => ({
      'cli.beta.private': true,
      'cli.beta.other': false,
      'cli.beta.stringy': 'yes',
    }));
    close.mockClear();
    close.mockImplementation(() => Promise.resolve(undefined));
    initialize.mockClear();
  });

  afterEach(() => {
    clientSideIdSpy?.mockRestore();
    clientSideIdSpy = undefined;
    if (previousUserHome === undefined) {
      delete process.env.SONAR_USER_HOME;
    } else {
      process.env.SONAR_USER_HOME = previousUserHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('initializes the SDK with local storage under the CLI LaunchDarkly dir', async () => {
    const flags = await fetchFlagsFromLaunchDarkly(cloudIdentity);

    expect(flags).toEqual({
      'cli.beta.private': true,
      'cli.beta.other': false,
      'cli.beta.stringy': false,
    });
    expect(initialize).toHaveBeenCalledTimes(1);
    const [, , options] = initialize.mock.calls[0] as [
      string,
      unknown,
      { localStoragePath: string; logger: LdClientLogger },
    ];
    expect(options.localStoragePath).toBe(getLaunchDarklyDir());
    expect(waitForInitialization).toHaveBeenCalledWith(LAUNCHDARKLY_INIT_TIMEOUT_SECONDS);
    expect(close).toHaveBeenCalledTimes(1);

    // Exercise the SDK logger adapters (debug/info/warn/error all map to logger.debug).
    options.logger.debug('d');
    options.logger.info('i');
    options.logger.warn('w');
    options.logger.error('e');
  });

  it('sends an enterprise context to LaunchDarkly when the UUID is known', async () => {
    await fetchFlagsFromLaunchDarkly({
      ...cloudIdentity,
      enterpriseUuid: 'ent-1',
    });

    const [, context] = initialize.mock.calls[0];
    expect(context).toEqual({
      kind: 'multi',
      user: { key: 'user-1' },
      organization: { key: 'org-1' },
      enterprise: { key: 'ent-1' },
    });
  });

  it('returns null when SDK initialization fails', async () => {
    waitForInitialization.mockImplementation(() => Promise.reject(new Error('timeout')));

    expect(await fetchFlagsFromLaunchDarkly(cloudIdentity)).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('returns null when the client-side ID is missing', async () => {
    clientSideIdSpy = spyOn(ldConstants, 'resolveLaunchDarklyClientSideId').mockReturnValue('');

    expect(await fetchFlagsFromLaunchDarkly(cloudIdentity)).toBeNull();
    expect(initialize).not.toHaveBeenCalled();
  });

  it('returns null when the identity cannot build an LD context', async () => {
    expect(
      await fetchFlagsFromLaunchDarkly({
        connectionType: 'cloud',
        userUuid: 'user-1',
        organizationUuidV4: null,
        enterpriseUuid: null,
        sqsInstallationId: null,
      }),
    ).toBeNull();
    expect(initialize).not.toHaveBeenCalled();
  });

  it('still returns flags when client.close rejects', async () => {
    close.mockImplementation(() => Promise.reject(new Error('close failed')));

    expect(await fetchFlagsFromLaunchDarkly(cloudIdentity)).toEqual({
      'cli.beta.private': true,
      'cli.beta.other': false,
      'cli.beta.stringy': false,
    });
  });
});

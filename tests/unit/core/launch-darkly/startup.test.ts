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

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import * as authResolver from '@/core/auth/auth-resolver.ts';
import * as launchDarkly from '@/core/launch-darkly';
import { loadPrivateBetaContext, resolveStartupAuth } from '@/core/launch-darkly/startup.ts';

const cloudAuth: ResolvedAuth = {
  connectionType: 'cloud',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'my-org',
  token: 'token',
};

describe('resolveStartupAuth', () => {
  afterEach(() => {
    mock.restore();
  });

  it('returns the resolved auth when resolveAuth succeeds', async () => {
    spyOn(authResolver, 'resolveAuth').mockResolvedValue(cloudAuth);

    expect(await resolveStartupAuth()).toEqual(cloudAuth);
  });

  it('returns null when resolveAuth throws', async () => {
    spyOn(authResolver, 'resolveAuth').mockRejectedValue(new Error('no keychain'));

    expect(await resolveStartupAuth()).toBeNull();
  });
});

describe('loadPrivateBetaContext', () => {
  afterEach(() => {
    mock.restore();
  });

  it('resolves auth then Private Beta flags for the given keys', async () => {
    spyOn(authResolver, 'resolveAuth').mockResolvedValue(cloudAuth);
    const resolveFlagsSpy = spyOn(launchDarkly, 'resolvePrivateBetaFlags').mockResolvedValue({
      'cli.beta.private': true,
    });

    expect(await loadPrivateBetaContext(['cli.beta.private'])).toEqual({
      auth: cloudAuth,
      flags: { 'cli.beta.private': true },
    });
    expect(resolveFlagsSpy).toHaveBeenCalledWith(cloudAuth, {
      flagKeys: ['cli.beta.private'],
    });
  });

  it('passes null auth through when startup auth fails', async () => {
    spyOn(authResolver, 'resolveAuth').mockRejectedValue(new Error('no keychain'));
    const resolveFlagsSpy = spyOn(launchDarkly, 'resolvePrivateBetaFlags').mockResolvedValue({});

    expect(await loadPrivateBetaContext(['cli.beta.private'])).toEqual({
      auth: null,
      flags: {},
    });
    expect(resolveFlagsSpy).toHaveBeenCalledWith(null, {
      flagKeys: ['cli.beta.private'],
    });
  });
});

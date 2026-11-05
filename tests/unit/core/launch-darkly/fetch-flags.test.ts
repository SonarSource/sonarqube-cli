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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { NetworkConfigError } from '@/core/errors.ts';
import { fetchFlagsFromLaunchDarkly } from '@/core/launch-darkly';
import * as ldConstants from '@/core/launch-darkly/constants.ts';
import type { FeatureFlagIdentity } from '@/core/launch-darkly/types.ts';
import logger from '@/core/observability/logger.ts';
import * as network from '@/core/server/fetch.ts';

const cloudIdentity: FeatureFlagIdentity = {
  connectionType: 'cloud',
  userUuid: 'user-1',
  organizationUuidV4: 'org-1',
  enterpriseUuid: null,
  sqsInstallationId: null,
};

describe('fetchFlagsFromLaunchDarkly', () => {
  let request: ReturnType<typeof spyOn<typeof network, 'fetchAuthenticated'>>;

  beforeEach(() => {
    request = spyOn(network, 'fetchAuthenticated').mockResolvedValue(
      Response.json({
        'cli.beta.private': { value: true, variation: 0 },
        'cli.beta.other': { value: false, variation: 1 },
        'cli.beta.stringy': { value: 'yes' },
      }),
    );
  });

  afterEach(() => request.mockRestore());

  it('fetches evaluations through the canonical network wrapper with a bounded request', async () => {
    expect(await fetchFlagsFromLaunchDarkly(cloudIdentity)).toEqual({
      'cli.beta.private': true,
      'cli.beta.other': false,
      'cli.beta.stringy': false,
    });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0];
    const endpoint = new URL(url);
    expect(endpoint.origin).toBe('https://clientsdk.launchdarkly.com');
    expect(endpoint.pathname).toStartWith(
      `/sdk/evalx/${ldConstants.resolveLaunchDarklyClientSideId()}/contexts/`,
    );
    expect(
      JSON.parse(Buffer.from(endpoint.pathname.split('/').at(-1)!, 'base64url').toString()),
    ).toEqual({
      kind: 'multi',
      user: { key: 'user-1' },
      organization: { key: 'org-1' },
    });
    expect(options.method).toBe('GET');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves the enterprise context', async () => {
    await fetchFlagsFromLaunchDarkly({ ...cloudIdentity, enterpriseUuid: 'ent-1' });
    const context = JSON.parse(
      Buffer.from(
        new URL(request.mock.calls[0][0]).pathname.split('/').at(-1)!,
        'base64url',
      ).toString(),
    );
    expect(context.enterprise).toEqual({ key: 'ent-1' });
  });

  it('accepts an empty successful evaluation without poisoning failures', async () => {
    request.mockResolvedValue(Response.json({}));
    expect(await fetchFlagsFromLaunchDarkly(cloudIdentity)).toEqual({});
  });

  for (const body of [null, [], 'invalid', { flag: null }, { flag: true }, { flag: {} }]) {
    it(`rejects malformed flag payload ${JSON.stringify(body)}`, async () => {
      request.mockResolvedValue(Response.json(body));
      expect(await fetchFlagsFromLaunchDarkly(cloudIdentity)).toBeNull();
    });
  }

  it('returns null for unsuccessful HTTP responses', async () => {
    request.mockResolvedValue(new Response('', { status: 503 }));
    expect(await fetchFlagsFromLaunchDarkly(cloudIdentity)).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    request.mockResolvedValue(new Response('invalid'));
    expect(await fetchFlagsFromLaunchDarkly(cloudIdentity)).toBeNull();
  });

  it('does not retry directly when the network policy rejects a request', async () => {
    request.mockRejectedValue(
      new NetworkConfigError('SONAR_HTTPS_PROXY_URL must be an HTTP(S) URL'),
    );
    const warning = spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(await fetchFlagsFromLaunchDarkly(cloudIdentity)).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      'LaunchDarkly flag refresh failed: SONAR_HTTPS_PROXY_URL must be an HTTP(S) URL',
    );
    warning.mockRestore();
  });

  it('returns null when the client-side ID is missing', async () => {
    const id = spyOn(ldConstants, 'resolveLaunchDarklyClientSideId').mockReturnValue('');
    try {
      expect(await fetchFlagsFromLaunchDarkly(cloudIdentity)).toBeNull();
      expect(request).not.toHaveBeenCalled();
    } finally {
      id.mockRestore();
    }
  });

  it('returns null when the context is incomplete', async () => {
    expect(
      await fetchFlagsFromLaunchDarkly({ ...cloudIdentity, organizationUuidV4: null }),
    ).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});

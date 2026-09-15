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

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import type { VortexEntitlementStatus } from '@/core/vortex/entitlement.ts';
import { VortexEntitlementClient } from '@/core/vortex/entitlement.ts';
import { recheckVortexEntitlement, resolveVortexEntitlement } from '@/core/vortex/entitlement.ts';

/** Every test stubs `hasVortexEntitlement`, so no request is ever issued through it. */
function transport(auth: ResolvedAuth): SonarHttpClient {
  return new SonarHttpClient(auth.serverUrl, auth.token);
}

function cloudAuth(orgKey = 'my-org'): ResolvedAuth {
  return new ResolvedAuth({
    token: 'tok',
    serverUrl: 'https://sonarcloud.io',
    orgKey,
    connectionType: 'cloud',
    source: 'state',
  });
}

describe('recheckVortexEntitlement', () => {
  let entitlementSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    entitlementSpy.mockRestore();
  });

  it('returns the client status verbatim and forwards the org key', async () => {
    entitlementSpy = spyOn(
      VortexEntitlementClient.prototype,
      'hasVortexEntitlement',
    ).mockResolvedValue({
      status: 'not_entitled',
    });

    const auth = cloudAuth('acme');
    const status = await recheckVortexEntitlement(transport(auth), auth);

    expect(status).toBe('not_entitled');
    expect(entitlementSpy).toHaveBeenCalledWith('acme');
  });

  it.each<VortexEntitlementStatus>(['enabled', 'over_consumption', 'not_entitled', 'check_failed'])(
    'passes through the %s verdict',
    async (verdict) => {
      entitlementSpy = spyOn(
        VortexEntitlementClient.prototype,
        'hasVortexEntitlement',
      ).mockResolvedValue({
        status: verdict,
      });

      expect(await recheckVortexEntitlement(transport(cloudAuth()), cloudAuth())).toBe(verdict);
    },
  );
});

function serverAuth(): ResolvedAuth {
  return new ResolvedAuth({
    token: 'tok',
    serverUrl: 'https://sonarqube.example.com',
    connectionType: 'on-premise',
    source: 'state' as const,
  });
}

describe('resolveVortexEntitlement', () => {
  let entitlementSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    entitlementSpy?.mockRestore();
  });

  it('returns not_applicable without calling the API for Cloud without an org', async () => {
    entitlementSpy = spyOn(VortexEntitlementClient.prototype, 'hasVortexEntitlement');
    const auth = new ResolvedAuth({ ...cloudAuth(), orgKey: undefined });
    expect(await resolveVortexEntitlement(transport(auth), auth)).toEqual({
      status: 'not_applicable',
    });
    expect(entitlementSpy).not.toHaveBeenCalled();
  });

  it('queries entitlement on a Server connection', async () => {
    entitlementSpy = spyOn(
      VortexEntitlementClient.prototype,
      'hasVortexEntitlement',
    ).mockResolvedValue({
      status: 'enabled',
    });
    const auth = serverAuth();
    expect(await resolveVortexEntitlement(transport(auth), auth)).toEqual({
      status: 'enabled',
    });
    expect(entitlementSpy).toHaveBeenCalled();
  });
});

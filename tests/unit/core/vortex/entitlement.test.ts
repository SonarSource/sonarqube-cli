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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import type { VortexEntitlementStatus } from '@/core/vortex/entitlement.ts';
import { VortexEntitlementClient } from '@/core/vortex/entitlement.ts';
import { recheckVortexEntitlement, resolveVortexEntitlement } from '@/core/vortex/entitlement.ts';

function cloudAuth(orgKey = 'my-org'): ResolvedAuth {
  return { token: 'tok', serverUrl: 'https://sonarcloud.io', orgKey, connectionType: 'cloud' };
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

    const status = await recheckVortexEntitlement(cloudAuth('acme'));

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

      expect(await recheckVortexEntitlement(cloudAuth())).toBe(verdict);
    },
  );
});

function serverAuth(): ResolvedAuth {
  return {
    token: 'tok',
    serverUrl: 'https://sonarqube.example.com',
    connectionType: 'on-premise',
  };
}

describe('resolveVortexEntitlement', () => {
  let entitlementSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    entitlementSpy?.mockRestore();
  });

  it('returns not_applicable without calling the API when unauthenticated', async () => {
    entitlementSpy = spyOn(VortexEntitlementClient.prototype, 'hasVortexEntitlement');
    expect(await resolveVortexEntitlement(null)).toEqual({ status: 'not_applicable' });
    expect(entitlementSpy).not.toHaveBeenCalled();
  });

  it('returns not_applicable without calling the API for Cloud without an org', async () => {
    entitlementSpy = spyOn(VortexEntitlementClient.prototype, 'hasVortexEntitlement');
    expect(await resolveVortexEntitlement({ ...cloudAuth(), orgKey: undefined })).toEqual({
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
    expect(await resolveVortexEntitlement(serverAuth())).toEqual({ status: 'enabled' });
    expect(entitlementSpy).toHaveBeenCalled();
  });
});

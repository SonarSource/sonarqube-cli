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
import { SonarQubeClient, type VortexEntitlementStatus } from '@/core/server/client.ts';
import { recheckVortexEntitlement } from '@/core/vortex/entitlement.ts';

function cloudAuth(orgKey = 'my-org'): ResolvedAuth {
  return { token: 'tok', serverUrl: 'https://sonarcloud.io', orgKey, connectionType: 'cloud' };
}

describe('recheckVortexEntitlement', () => {
  let entitlementSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    entitlementSpy.mockRestore();
  });

  it('returns the client status verbatim and forwards the org key', async () => {
    entitlementSpy = spyOn(SonarQubeClient.prototype, 'hasVortexEntitlement').mockResolvedValue(
      'not_entitled',
    );

    const status = await recheckVortexEntitlement(cloudAuth('acme'));

    expect(status).toBe('not_entitled');
    expect(entitlementSpy).toHaveBeenCalledWith('acme');
  });

  it.each<VortexEntitlementStatus>(['enabled', 'over_consumption', 'not_entitled', 'check_failed'])(
    'passes through the %s verdict',
    async (verdict) => {
      entitlementSpy = spyOn(SonarQubeClient.prototype, 'hasVortexEntitlement').mockResolvedValue(
        verdict,
      );

      expect(await recheckVortexEntitlement(cloudAuth())).toBe(verdict);
    },
  );
});

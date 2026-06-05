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

import { afterEach, describe, expect, it } from 'bun:test';

import { FakeSonarQubeServerBuilder } from './fake-sonarqube-server.js';

const HTTP_OK = 200;
import type { FakeSonarQubeServer } from './fake-sonarqube-server.js';

describe('FakeSonarQubeServer — UUID consistency', () => {
  let server: FakeSonarQubeServer;

  afterEach(async () => {
    await server?.stop();
  });

  it('returns cag-org-config 200 when org has both SQAA and CAG entitlement with a custom UUID', async () => {
    // This test demonstrates the UUID mismatch bug:
    //
    // withSqaaEntitlement stores an explicit UUID ('test-uuid-1234').
    // withCagEntitlement stores no UUID — the cag-org-config lookup derives it
    // as `${orgKey}-uuid-v4`.
    //
    // When CAG calls /organizations/organizations (no param), the no-param
    // branch synthesises org entries taking the UUID from SQAA ('test-uuid-1234').
    // CAG then calls /a3s-analysis/cag-org-config/test-uuid-1234, but the handler
    // looks for an org where `${orgKey}-uuid-v4 === 'test-uuid-1234'`, which never
    // matches — so it returns 404 and CAG treats itself as not entitled.

    server = await new FakeSonarQubeServerBuilder()
      .withSqaaEntitlement('my-org', 'test-uuid-1234')
      .withCagEntitlement('my-org')
      .start();

    const base = server.baseUrl();

    // Step 1: fetch org list (no param) — this is what CAG calls during startup.
    const orgsResp = await fetch(`${base}/organizations/organizations`);
    const orgs = (await orgsResp.json()) as Array<{ key: string; uuidV4: string }>;

    expect(orgs).toHaveLength(1);
    expect(orgs[0].key).toBe('my-org');

    const uuid = orgs[0].uuidV4;

    // Step 2: fetch cag-org-config using the UUID CAG received from step 1.
    const configResp = await fetch(`${base}/a3s-analysis/cag-org-config/${uuid}`);

    // Expected: 200 with eligible/enabled from withCagEntitlement.
    // Actual (bug): 404 because the handler derives UUID as `${orgKey}-uuid-v4`
    // but the UUID returned by /organizations/organizations is 'test-uuid-1234'
    // (taken from SQAA), not 'my-org-uuid-v4'.
    expect(configResp.status).toBe(HTTP_OK);

    const config = (await configResp.json()) as { eligible: boolean; enabled: boolean };
    expect(config.eligible).toBe(true);
    expect(config.enabled).toBe(true);
  });
});

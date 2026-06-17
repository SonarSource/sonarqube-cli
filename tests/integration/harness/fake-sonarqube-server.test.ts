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

  it('returns cag-entitlement 200 when org has both SQAA and CAG entitlement', async () => {
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

    // Step 2: fetch CAG entitlement using the UUID CAG received from step 1.
    const configResp = await fetch(`${base}/a3s-analysis/cag-entitlement/${uuid}`);

    expect(configResp.status).toBe(HTTP_OK);

    const config = (await configResp.json()) as { allowed: boolean };
    expect(config.allowed).toBe(true);
  });
});

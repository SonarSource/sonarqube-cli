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

  it.each([
    ['main', 'main'],
    ['main', 'feature'],
    ['trunk', 'trunk'],
  ])('omits analysisDate only for unanalyzed branch %s/%s', async (main, unanalyzed) => {
    server = await new FakeSonarQubeServerBuilder()
      .withProject('shop', (project) =>
        project
          .withDefaultBranchName(main)
          .withBranches([main, 'feature', 'analyzed'])
          .withUnanalyzedBranch(unanalyzed),
      )
      .start();
    const response = await fetch(`${server.baseUrl()}/api/project_branches/list?project=shop`);
    const { branches } = (await response.json()) as {
      branches: { name: string; analysisDate?: string }[];
    };
    expect(branches).toHaveLength(3);
    for (const branch of branches) {
      if (branch.name === unanalyzed) {
        expect(branch).not.toHaveProperty('analysisDate');
      } else {
        expect(branch.analysisDate).toBeTruthy();
      }
    }
  });

  it('preserves an explicit null public project lookup response', async () => {
    server = await new FakeSonarQubeServerBuilder().withProjectsLookupResponse(200, null).start();

    const response = await fetch(`${server.baseUrl()}/api/v2/components/projects?keys=shop`);

    expect(response.status).toBe(HTTP_OK);
    expect(await response.json()).toBeNull();
  });

  it('returns cag-entitlement 200 when org has both SQAA and CAG entitlement', async () => {
    server = await new FakeSonarQubeServerBuilder()
      .withSqaaEntitlement('my-org', 'test-uuid-1234')
      .withCagEntitlement('my-org', 'test-uuid-1234')
      .start();

    const base = server.baseUrl();

    // Step 1: fetch org list (no param) — this is what CAG calls during startup.
    const orgsResp = await fetch(`${base}/organizations/organizations`);
    const orgs = (await orgsResp.json()) as Array<{ key: string; uuidV4: string }>;

    expect(orgs).toHaveLength(1);
    expect(orgs[0].key).toBe('my-org');

    const uuid = orgs[0].uuidV4;

    const configResp = await fetch(`${base}/cag/cag-entitlement/${uuid}`);
    expect(configResp.status).toBe(HTTP_OK);
    expect(((await configResp.json()) as { allowed: boolean }).allowed).toBe(true);

    const serverPathResp = await fetch(`${base}/api/v2/cag/cag-entitlement/${uuid}`);
    expect(serverPathResp.status).toBe(HTTP_OK);
    expect(((await serverPathResp.json()) as { allowed: boolean }).allowed).toBe(true);

    const sqaaCloudResp = await fetch(`${base}/a3s-analysis/org-entitlement/${uuid}`);
    expect(sqaaCloudResp.status).toBe(HTTP_OK);
    const sqaaServerResp = await fetch(`${base}/api/v2/a3s/org-entitlement/${uuid}`);
    expect(sqaaServerResp.status).toBe(HTTP_OK);
  });
});

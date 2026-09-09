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

import { SONARCLOUD_URL } from '@/core/config-constants.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { ScaClient } from '@/core/server/sca.ts';
import type { ScaIssuesReleasesResponse } from '@/core/server/types.ts';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

const SERVER_URL = 'https://sonarqube.example.com';
const TOKEN = 'squ_test_token';

const SAMPLE_RESPONSE: ScaIssuesReleasesResponse = {
  issuesReleases: [
    {
      key: 'RISK-1',
      severity: 'HIGH',
      type: 'VULNERABILITY',
      vulnerabilityId: 'CVE-2021-23337',
      release: { packageName: 'lodash', version: '4.17.20' },
    },
  ],
  page: { pageIndex: 1, pageSize: 10, total: 1 },
};

describe('ScaClient.getWorstIssuesReleases', () => {
  let client: ScaClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new ScaClient(new SonarHttpClient(SERVER_URL, TOKEN));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('requests /api/v2/sca/issues-releases on a non-cloud connection', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE_RESPONSE));

    await client.getWorstIssuesReleases({
      projectKey: 'my-project',
      types: ['VULNERABILITY'],
      top: 10,
    });

    const url = (fetchSpy.mock.calls[0][0] as URL).toString();
    expect(url).toContain('/api/v2/sca/issues-releases');
    expect(url).toContain('projectKey=my-project');
    expect(url).toContain('types=VULNERABILITY');
    expect(url).toContain('statuses=OPEN%2CCONFIRM');
    expect(url).toContain('sort=-severity');
    expect(url).toContain('pageSize=10');
  });

  it('joins multiple types with a comma', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE_RESPONSE));

    await client.getWorstIssuesReleases({
      projectKey: 'my-project',
      types: ['MALWARE', 'VULNERABILITY'],
      top: 10,
    });

    const url = (fetchSpy.mock.calls[0][0] as URL).toString();
    expect(url).toContain('types=MALWARE%2CVULNERABILITY');
  });

  it('omits newlyIntroduced, branch and pull request from the query when not given', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE_RESPONSE));

    await client.getWorstIssuesReleases({
      projectKey: 'my-project',
      types: ['VULNERABILITY'],
      top: 10,
    });

    const url = (fetchSpy.mock.calls[0][0] as URL).toString();
    expect(url).not.toContain('newlyIntroduced');
    expect(url).not.toContain('branchKey');
    expect(url).not.toContain('pullRequestKey');
  });

  it('ignores orgKey on a non-cloud connection', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE_RESPONSE));

    await client.getWorstIssuesReleases({
      projectKey: 'my-project',
      types: ['VULNERABILITY'],
      top: 10,
      orgKey: 'my-org',
    });

    const url = (fetchSpy.mock.calls[0][0] as URL).toString();
    expect(url).not.toContain('organization');
  });

  it('forwards orgKey as the organization query param on a cloud connection', async () => {
    const cloudClient = new ScaClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE_RESPONSE));

    await cloudClient.getWorstIssuesReleases({
      projectKey: 'my-project',
      types: ['VULNERABILITY'],
      top: 10,
      orgKey: 'my-org',
    });

    const url = (fetchSpy.mock.calls[0][0] as URL).toString();
    expect(url).toContain('organization=my-org');
  });

  it('omits organization on a cloud connection when orgKey is not given', async () => {
    const cloudClient = new ScaClient(new SonarHttpClient(SONARCLOUD_URL, TOKEN));
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE_RESPONSE));

    await cloudClient.getWorstIssuesReleases({
      projectKey: 'my-project',
      types: ['VULNERABILITY'],
      top: 10,
    });

    const url = (fetchSpy.mock.calls[0][0] as URL).toString();
    expect(url).not.toContain('organization');
  });

  it('forwards newlyIntroduced, branch and pull request when given', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE_RESPONSE));

    await client.getWorstIssuesReleases({
      projectKey: 'my-project',
      types: ['VULNERABILITY'],
      newlyIntroduced: true,
      top: 10,
      branch: 'feature-x',
    });
    expect((fetchSpy.mock.calls[0][0] as URL).toString()).toContain('newlyIntroduced=true');
    expect((fetchSpy.mock.calls[0][0] as URL).toString()).toContain('branchKey=feature-x');

    await client.getWorstIssuesReleases({
      projectKey: 'my-project',
      types: ['VULNERABILITY'],
      top: 10,
      pullRequest: '42',
    });
    expect((fetchSpy.mock.calls[1][0] as URL).toString()).toContain('pullRequestKey=42');
  });

  it('returns the risks and the total count from the response paging', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(SAMPLE_RESPONSE));

    const result = await client.getWorstIssuesReleases({
      projectKey: 'my-project',
      types: ['VULNERABILITY'],
      top: 10,
    });

    expect(result).toEqual({ issuesReleases: SAMPLE_RESPONSE.issuesReleases, totalCount: 1 });
  });
});

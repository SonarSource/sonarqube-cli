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

import type { AttachBreakdownsParams } from '@/commands/quality-gate/status/breakdown.ts';
import type { QualityGateConditionSummary } from '@/commands/quality-gate/status/condition-summary.ts';
import { fetchDependencyRisksBreakdown } from '@/commands/quality-gate/status/dependency-risks-enrichment.ts';
import { okAsync } from '@/core/result.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import type { GetWorstIssuesReleasesResult } from '@/core/server/sca.ts';
import { ScaClient } from '@/core/server/sca.ts';

const CONDITION: QualityGateConditionSummary = {
  metric: 'sca_count_vulnerability',
  metricName: 'Count of vulnerability dependency risks',
  status: 'ERROR',
  comparator: 'GT',
};

const PARAMS: AttachBreakdownsParams = {
  client: new SonarHttpClient('https://sonarqube.example.com', 'token'),
  projectKey: 'my-project',
  metrics: [],
  top: 10,
};

describe('fetchDependencyRisksBreakdown', () => {
  let getWorstIssuesReleasesSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    getWorstIssuesReleasesSpy?.mockRestore();
  });

  it('degrades to undefined instead of throwing when a risk entry has no release payload', async () => {
    // Simulates a malformed server payload the declared `ScaIssueRelease` type rules out.
    const malformedResult = {
      issuesReleases: [{ key: 'RISK-1', severity: 'HIGH', type: 'VULNERABILITY' }],
      totalCount: 1,
    } as unknown as GetWorstIssuesReleasesResult;

    getWorstIssuesReleasesSpy = spyOn(
      ScaClient.prototype,
      'getWorstIssuesReleases',
    ).mockReturnValue(okAsync(malformedResult));

    const breakdown = await fetchDependencyRisksBreakdown(PARAMS, CONDITION);

    expect(breakdown).toBeUndefined();
  });
});

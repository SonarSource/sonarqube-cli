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

import { describe, expect, it } from 'bun:test';

import {
  formatIssueBreakdown,
  type IssueBreakdown,
  readIssueBreakdown,
} from '@/commands/init/scan/issue-breakdown.ts';
import { errAsync, okAsync } from '@/core/result.ts';
import type { IssuesClient } from '@/core/server/issues.ts';
import type { IssuesSearchParams, IssuesSearchResponse } from '@/core/server/types.ts';

type Severity = 'BLOCKER' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

function response(total: number, counts: Partial<Record<Severity, number>>): IssuesSearchResponse {
  return {
    total,
    p: 1,
    ps: 1,
    paging: { pageIndex: 1, pageSize: 1, total },
    issues: [],
    facets: [
      {
        property: 'impactSeverities',
        values: Object.entries(counts).map(([val, count]) => ({ val, count })),
      },
    ],
  };
}

const BY_QUALITY: Record<string, IssuesSearchResponse> = {
  SECURITY: response(57, { BLOCKER: 2, HIGH: 14, MEDIUM: 31, LOW: 10 }),
  RELIABILITY: response(230, { HIGH: 22, MEDIUM: 140, LOW: 65, INFO: 3 }),
  MAINTAINABILITY: response(2026, { HIGH: 310, MEDIUM: 960, LOW: 680, INFO: 76 }),
};

function clientAnswering(answer: (params: IssuesSearchParams) => IssuesSearchResponse | Error) {
  const calls: IssuesSearchParams[] = [];
  const client = {
    searchIssues: (params: IssuesSearchParams) => {
      calls.push(params);
      const result = answer(params);
      return result instanceof Error ? errAsync(result) : okAsync(result);
    },
  } as unknown as IssuesClient;
  return { client, calls };
}

describe('readIssueBreakdown', () => {
  it('asks once per software quality for its severities, among the open issues of the project', async () => {
    const { client, calls } = clientAnswering(
      (params) => BY_QUALITY[params.impactSoftwareQualities!],
    );

    const breakdown = await readIssueBreakdown(
      { issues: client, projectKey: 'my-key', organization: 'my-org' },
      2313,
    );

    expect(calls.map((call) => call.impactSoftwareQualities).sort()).toEqual([
      'MAINTAINABILITY',
      'RELIABILITY',
      'SECURITY',
    ]);
    for (const call of calls) {
      expect(call).toMatchObject({
        projects: 'my-key',
        organization: 'my-org',
        issueStatuses: 'OPEN,CONFIRMED',
        facets: 'impactSeverities',
        ps: 1,
      });
    }
    expect(breakdown?.distinctIssues).toBe(2313);
    expect(breakdown?.rows.map((row) => [row.quality, row.total])).toEqual([
      ['SECURITY', 57],
      ['RELIABILITY', 230],
      ['MAINTAINABILITY', 2026],
    ]);
    expect(breakdown?.rows[0].bySeverity).toEqual({
      BLOCKER: 2,
      HIGH: 14,
      MEDIUM: 31,
      LOW: 10,
      INFO: 0,
    });
  });

  it('is absent rather than partial when one request fails', async () => {
    const { client } = clientAnswering((params) =>
      params.impactSoftwareQualities === 'RELIABILITY'
        ? new Error('500')
        : BY_QUALITY[params.impactSoftwareQualities!],
    );

    expect(
      await readIssueBreakdown({ issues: client, projectKey: 'k', organization: 'o' }, 5),
    ).toBeNull();
  });

  it('is absent when the server does not return the severity facet', async () => {
    const { client } = clientAnswering(() => ({ ...BY_QUALITY.SECURITY, facets: undefined }));

    expect(
      await readIssueBreakdown({ issues: client, projectKey: 'k', organization: 'o' }, 5),
    ).toBeNull();
  });
});

describe('formatIssueBreakdown', () => {
  const rows = (
    entries: Array<[IssueBreakdown['rows'][number]['quality'], Partial<Record<Severity, number>>]>,
  ): IssueBreakdown['rows'] =>
    entries.map(([quality, counts]) => {
      const bySeverity = { BLOCKER: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0, ...counts };
      return { quality, bySeverity, total: Object.values(bySeverity).reduce((a, b) => a + b, 0) };
    });

  it('lays the counts out as an aligned grid with right-aligned numbers', () => {
    const lines = formatIssueBreakdown({
      distinctIssues: 2290,
      rows: rows([
        ['SECURITY', { BLOCKER: 2, HIGH: 14, MEDIUM: 31, LOW: 10 }],
        ['RELIABILITY', { HIGH: 22, MEDIUM: 140, LOW: 65, INFO: 3 }],
        ['MAINTAINABILITY', { HIGH: 310, MEDIUM: 960, LOW: 680, INFO: 76 }],
      ]),
    });

    expect(lines).toEqual([
      '',
      '  QUALITY          BLOCKER  HIGH  MEDIUM  LOW  INFO  TOTAL',
      '  Security               2    14      31   10     0     57',
      '  Reliability            0    22     140   65     3    230',
      '  Maintainability        0   310     960  680    76   2026',
      '',
      '  An issue with impacts in several qualities is counted in each of them.',
      '',
    ]);
  });

  it('omits the note when no issue can be counted twice', () => {
    const lines = formatIssueBreakdown({
      distinctIssues: 3,
      rows: rows([
        ['SECURITY', { HIGH: 1 }],
        ['RELIABILITY', { LOW: 2 }],
        ['MAINTAINABILITY', {}],
      ]),
    });

    expect(lines.join('\n')).not.toContain('counted in each');
    expect(lines).toHaveLength(6);
  });
});

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

import { SonarQubeClient } from '@/core/server/client.ts';
import { MeasuresClient } from '@/core/server/measures.ts';
import type { ComponentTreeComponent, ComponentTreeResponse } from '@/core/server/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

function component(overrides: Partial<ComponentTreeComponent> = {}): ComponentTreeComponent {
  return {
    key: overrides.key ?? 'my-project:src/foo.ts',
    name: overrides.name ?? 'foo.ts',
    qualifier: overrides.qualifier ?? 'FIL',
    path: overrides.path ?? 'src/foo.ts',
    measures: overrides.measures ?? [
      { metric: 'new_coverage', periods: [{ index: 1, value: '0.0' }] },
    ],
  };
}

function componentTreeResponse(
  overrides: Partial<ComponentTreeResponse> = {},
): ComponentTreeResponse {
  const components = overrides.components ?? [component()];
  return {
    paging: overrides.paging ?? { pageIndex: 1, pageSize: 3, total: components.length },
    baseComponent: overrides.baseComponent ?? {
      key: 'my-project',
      name: 'my-project',
      qualifier: 'TRK',
      measures: [],
    },
    components,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SERVER_URL = 'https://sonarqube.example.com';
const TOKEN = 'squ_test_token';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MeasuresClient', () => {
  let client: MeasuresClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new MeasuresClient(new SonarQubeClient(SERVER_URL, TOKEN));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('sorts by metricPeriod, not metric - new_* metrics store their value under periods[]', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(componentTreeResponse()));

    await client.getWorstComponentsByMetric({
      projectKey: 'my-project',
      metricKey: 'new_coverage',
      ascending: true,
      top: 3,
    });

    const url = (fetchSpy.mock.calls[0][0] as URL).toString();
    expect(url).toContain('s=metricPeriod');
    expect(url).toContain('metricPeriodSort=1');
    expect(url).toContain('metricSort=new_coverage');
    expect(url).toContain('metricSortFilter=withMeasuresOnly');
    expect(url).not.toContain('s=metric&');
  });

  it('sorts by metric, not metricPeriod, for an overall (non-new_) metric - its value lives in the flat value field', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(componentTreeResponse()));

    await client.getWorstComponentsByMetric({
      projectKey: 'my-project',
      metricKey: 'coverage',
      ascending: true,
      top: 3,
    });

    const url = new URL(fetchSpy.mock.calls[0][0] as URL);
    expect(url.searchParams.get('s')).toBe('metric');
    expect(url.searchParams.get('metricSort')).toBe('coverage');
    expect(url.searchParams.has('metricPeriodSort')).toBe(false);
  });

  it('scopes to files only, requests exactly `top` results, and passes ascending order through', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(componentTreeResponse()));

    await client.getWorstComponentsByMetric({
      projectKey: 'my-project',
      metricKey: 'new_coverage',
      ascending: false,
      top: 5,
    });

    const url = (fetchSpy.mock.calls[0][0] as URL).toString();
    expect(url).toContain('component=my-project');
    expect(url).toContain('metricKeys=new_coverage');
    expect(url).toContain('qualifiers=FIL');
    expect(url).toContain('ps=5');
    expect(url).toContain('asc=false');
  });

  it('omits branch and pull request from the query when not given', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(componentTreeResponse()));

    await client.getWorstComponentsByMetric({
      projectKey: 'my-project',
      metricKey: 'new_coverage',
      ascending: true,
      top: 3,
    });

    const url = (fetchSpy.mock.calls[0][0] as URL).toString();
    expect(url).not.toContain('branch=');
    expect(url).not.toContain('pullRequest=');
  });

  it('forwards branch and pull request when given', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(componentTreeResponse()));

    await client.getWorstComponentsByMetric({
      projectKey: 'my-project',
      metricKey: 'new_coverage',
      ascending: true,
      top: 3,
      branch: 'feature-x',
    });
    expect((fetchSpy.mock.calls[0][0] as URL).toString()).toContain('branch=feature-x');

    await client.getWorstComponentsByMetric({
      projectKey: 'my-project',
      metricKey: 'new_coverage',
      ascending: true,
      top: 3,
      pullRequest: '42',
    });
    expect((fetchSpy.mock.calls[1][0] as URL).toString()).toContain('pullRequest=42');
  });

  it('returns the components array from the response', async () => {
    const components = [component({ path: 'src/a.ts' }), component({ path: 'src/b.ts' })];
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(componentTreeResponse({ components })),
    );

    const result = await client.getWorstComponentsByMetric({
      projectKey: 'my-project',
      metricKey: 'new_coverage',
      ascending: true,
      top: 3,
    });

    expect(result.components).toEqual(components);
  });

  it('returns the total count from paging, independent of how many components the page holds', async () => {
    const components = [component({ path: 'src/a.ts' })];
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        componentTreeResponse({ components, paging: { pageIndex: 1, pageSize: 1, total: 47 } }),
      ),
    );

    const result = await client.getWorstComponentsByMetric({
      projectKey: 'my-project',
      metricKey: 'new_coverage',
      ascending: true,
      top: 1,
    });

    expect(result.totalCount).toBe(47);
  });
});

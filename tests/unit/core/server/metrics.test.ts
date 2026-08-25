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
import { MetricsClient } from '@/core/server/metrics.ts';
import type { Metric, MetricsSearchResponse } from '@/core/server/types.ts';

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

function metric(overrides: Partial<Metric> = {}): Metric {
  return {
    key: overrides.key ?? 'new_coverage',
    type: overrides.type ?? 'PERCENT',
    name: overrides.name ?? 'Coverage on New Code',
  };
}

function searchResponse(overrides: Partial<MetricsSearchResponse> = {}): MetricsSearchResponse {
  const metrics = overrides.metrics ?? [metric()];
  return {
    metrics,
    total: overrides.total ?? metrics.length,
    p: overrides.p ?? 1,
    ps: overrides.ps ?? 500,
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

describe('MetricsClient', () => {
  let client: MetricsClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new MetricsClient(new SonarQubeClient(SERVER_URL, TOKEN));
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('fetches the catalog in one request with ps=500', async () => {
    const metrics = [metric({ key: 'new_coverage' }), metric({ key: 'reliability_rating' })];
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(searchResponse({ metrics })),
    );

    const result = await client.searchMetrics();

    expect(result).toEqual(metrics);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = (fetchSpy.mock.calls[0][0] as URL).toString();
    expect(url).toContain('/api/metrics/search');
    expect(url).toContain('p=1');
    expect(url).toContain('ps=500');
  });

  it('preserves each metric field', async () => {
    const percentMetric = metric({ key: 'new_coverage', type: 'PERCENT' });
    const ratingMetric = metric({
      key: 'security_rating',
      type: 'RATING',
      name: 'Security Rating',
    });
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(searchResponse({ metrics: [percentMetric, ratingMetric] })),
    );

    const result = await client.searchMetrics();

    expect(result).toEqual([percentMetric, ratingMetric]);
  });

  it('paginates when the catalog exceeds one page', async () => {
    const firstPage = [metric({ key: 'metric_1' }), metric({ key: 'metric_2' })];
    const secondPage = [metric({ key: 'metric_3' })];
    fetchSpy = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(searchResponse({ metrics: firstPage, total: 3, p: 1 })))
      .mockResolvedValueOnce(jsonResponse(searchResponse({ metrics: secondPage, total: 3, p: 2 })));

    const result = await client.searchMetrics();

    expect(result).toEqual([...firstPage, ...secondPage]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondUrl = (fetchSpy.mock.calls[1][0] as URL).toString();
    expect(secondUrl).toContain('p=2');
  });

  it('stops without looping when the server reports an empty catalog', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(searchResponse({ metrics: [], total: 0 })),
    );

    const result = await client.searchMetrics();

    expect(result).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

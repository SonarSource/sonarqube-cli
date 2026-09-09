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

// SonarQube Metrics API wrapper

import { okAsync, type ResultAsync } from '../result.ts';
import { type HttpClientError } from './errors.ts';
import { type SonarHttpClient } from './http-client.ts';
import type { Metric, MetricsSearchResponse } from './types.ts';

/** `api/metrics/search` has no key/name filter, so a full-catalog fetch is the only option. */
const METRICS_PAGE_SIZE = 500;

export class MetricsClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /**
   * Fetch the entire metric catalog, fresh, on every call — no caching. A single `ps=500` request
   * covers every server observed so far (well under 500 metrics); pagination only kicks in for a
   * hypothetical catalog exceeding that.
   */
  searchMetrics(): ResultAsync<Metric[], HttpClientError> {
    return this.fetchPage(1, []);
  }

  private fetchPage(page: number, accumulated: Metric[]): ResultAsync<Metric[], HttpClientError> {
    return this.client
      .get<MetricsSearchResponse>('/api/metrics/search', {
        p: page,
        ps: METRICS_PAGE_SIZE,
      })
      .andThen((response) => {
        const metrics = [...accumulated, ...response.metrics];
        if (metrics.length < response.total && response.metrics.length > 0) {
          return this.fetchPage(page + 1, metrics);
        }
        return okAsync(metrics);
      });
  }
}

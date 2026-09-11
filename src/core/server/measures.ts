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

// SonarQube Measures API wrapper

import type { ResultAsync } from '@/core/result.ts';

import { type HttpClientError } from './errors.ts';
import { type QueryParams, type SonarHttpClient } from './http-client.ts';
import type {
  ComponentMeasuresResponse,
  ComponentTreeComponent,
  ComponentTreeResponse,
} from './types.ts';

export interface ComponentMeasuresParams {
  componentKey: string;
  metricKeys: string[];
  branch?: string;
  pullRequest?: string;
}

export interface WorstComponentsByMetricParams {
  component: string;
  metricKey: string;
  ascending: boolean;
  top: number;
  branch?: string;
  pullRequest?: string;
}

export interface WorstComponentsByMetricResult {
  components: ComponentTreeComponent[];
  totalCount: number;
}

/**
 * A `new_*` metric's value lives under `measures[].periods[]`, not the flat `measures[].value`
 * field.
 */
export function isNewCodeMetric(metricKey: string): boolean {
  return metricKey.startsWith('new_');
}

export function extractMeasureValue(
  measures: ComponentTreeComponent['measures'],
  metricKey: string,
): string | undefined {
  const measure = measures.find((m) => m.metric === metricKey);
  return isNewCodeMetric(metricKey)
    ? measure?.periods?.[0]?.value
    : (measure?.value ?? measure?.periods?.[0]?.value);
}

/**
 * Uses a different params sets for a new code metric.
 */
function buildComponentTreeQueryParams(params: WorstComponentsByMetricParams): QueryParams {
  const queryParams: QueryParams = {
    component: params.component,
    metricKeys: params.metricKey,
    metricSort: params.metricKey,
    metricSortFilter: 'withMeasuresOnly',
    asc: params.ascending,
    qualifiers: 'FIL',
    ps: params.top,
  };
  if (isNewCodeMetric(params.metricKey)) {
    queryParams.s = 'metricPeriod';
    queryParams.metricPeriodSort = 1;
  } else {
    queryParams.s = 'metric';
  }
  if (params.branch) {
    queryParams.branch = params.branch;
  }
  if (params.pullRequest) {
    queryParams.pullRequest = params.pullRequest;
  }
  return queryParams;
}

export class MeasuresClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /** Worst-N files for a single metric, e.g. `new_coverage` or `coverage`. */
  getWorstComponentsByMetric(
    params: WorstComponentsByMetricParams,
  ): ResultAsync<WorstComponentsByMetricResult, HttpClientError> {
    return this.client
      .get<ComponentTreeResponse>(
        '/api/measures/component_tree',
        buildComponentTreeQueryParams(params),
      )
      .map((response) => ({
        components: response.components,
        totalCount: response.paging.total,
      }));
  }

  /**
   * A single component's own measures.
   */
  getComponentMeasures(
    params: ComponentMeasuresParams,
  ): ResultAsync<ComponentTreeComponent, HttpClientError> {
    const queryParams: QueryParams = {
      component: params.componentKey,
      metricKeys: params.metricKeys.join(','),
    };
    if (params.branch) {
      queryParams.branch = params.branch;
    }
    if (params.pullRequest) {
      queryParams.pullRequest = params.pullRequest;
    }
    return this.client
      .get<ComponentMeasuresResponse>('/api/measures/component', queryParams)
      .map((response) => response.component);
  }
}

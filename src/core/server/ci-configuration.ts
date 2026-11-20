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

// SonarQube Server CI configuration runs API wrapper: server-side execution of `onboard-ci`.

import { errAsync, okAsync, type ResultAsync } from '../result.ts';
import { AccessDeniedError, type HttpClientError, UnexpectedApiError } from './errors.ts';
import type { SonarHttpClient } from './http-client.ts';
import {
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
  HTTP_STATUS_NOT_FOUND,
} from './http-constants.ts';
import type { Paging } from './paging.ts';

const CI_CONFIGURATION_ENDPOINT = '/api/v2/onboarding/ci-configuration';
const RUNS_ENDPOINT = `${CI_CONFIGURATION_ENDPOINT}/runs`;
const CAPABILITIES_ENDPOINT = `${CI_CONFIGURATION_ENDPOINT}/capabilities`;

export type CiProviderType = 'GITLAB';
export type CiTriggerOn = 'MR' | 'MAIN' | 'BOTH';
export type CiRunStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type CiRunItemStatus = 'QUEUED' | 'RUNNING' | 'OPENED' | 'WOULD_OPEN' | 'SKIPPED' | 'FAILED';

const TERMINAL_RUN_STATUSES: ReadonlySet<CiRunStatus> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export function isTerminalCiRunStatus(status: CiRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export interface CiConfigurationCapabilities {
  runs: boolean;
  status: boolean;
  providers: string[];
}

export interface CiRunSelection {
  projectKeys?: string[];
  groupPath?: string;
  repoPaths?: string[];
}

export interface CiRunOptions {
  triggerOn?: CiTriggerOn;
  stage?: string;
  allowFailure?: boolean;
  sonarTokenVarName?: string;
  scannerProperties?: string[];
  jobTemplate?: string;
  serverUrl?: string;
  skipAnalyzedProjects?: boolean;
}

export interface CiRunCredential {
  type: 'PERSONAL_ACCESS_TOKEN';
  token: string;
}

export interface CreateCiConfigurationRunRequest {
  provider: CiProviderType;
  dopSettingKey?: string;
  selection: CiRunSelection;
  options?: CiRunOptions;
  dryRun: boolean;
  credential: CiRunCredential;
}

export interface CreateCiConfigurationRunResponse {
  id: string;
  status: CiRunStatus;
}

export interface CiRunCounts {
  total: number;
  queued: number;
  running: number;
  opened: number;
  wouldOpen: number;
  skipped: number;
  failed: number;
}

export interface CiConfigurationRun {
  id: string;
  provider: CiProviderType;
  dopSettingKey: string;
  dryRun: boolean;
  status: CiRunStatus;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdBy: string;
  counts: CiRunCounts;
  skippedByReason: Record<string, number>;
  error?: string | null;
}

export interface CiRunItem {
  repository: string;
  projectKey?: string | null;
  status: CiRunItemStatus;
  skipReason?: string | null;
  mergeRequestUrl?: string | null;
  error?: string | null;
}

export interface CiRunItemsPage {
  items: CiRunItem[];
  page: Paging;
}

export class CiConfigurationClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /** Never log or echo `request.credential.token`: it only belongs in this request body. */
  createRun(
    request: CreateCiConfigurationRunRequest,
  ): ResultAsync<CreateCiConfigurationRunResponse, HttpClientError> {
    return this.client.post<CreateCiConfigurationRunResponse>(RUNS_ENDPOINT, request);
  }

  getRun(runId: string): ResultAsync<CiConfigurationRun, HttpClientError> {
    return this.client.get<CiConfigurationRun>(runPath(runId));
  }

  getRunItems(
    runId: string,
    pageIndex: number,
    pageSize: number,
    status?: CiRunItemStatus,
  ): ResultAsync<CiRunItemsPage, HttpClientError> {
    return this.client.get<CiRunItemsPage>(`${runPath(runId)}/items`, {
      pageIndex,
      pageSize,
      ...(status ? { status } : {}),
    });
  }

  cancelRun(runId: string): ResultAsync<void, HttpClientError> {
    return this.client.postJsonDiscardingBody(`${runPath(runId)}/cancel`, {});
  }

  /** Null when the server does not expose the capabilities endpoint (404, 405 or 403). Other failures propagate. */
  getCapabilities(): ResultAsync<CiConfigurationCapabilities | null, HttpClientError> {
    return this.client
      .get<Partial<CiConfigurationCapabilities> | null>(CAPABILITIES_ENDPOINT)
      .map(normalizeCapabilities)
      .orElse((error) => (isUnsupportedEndpointError(error) ? okAsync(null) : errAsync(error)));
  }

  /** True only when runs are enabled for this instance and GitLab is a supported provider. */
  probeSupport(): ResultAsync<boolean, HttpClientError> {
    return this.getCapabilities().map(
      (capabilities) => capabilities?.runs === true && capabilities.providers.includes('GITLAB'),
    );
  }
}

function normalizeCapabilities(
  body: Partial<CiConfigurationCapabilities> | null,
): CiConfigurationCapabilities {
  return {
    runs: body?.runs === true,
    status: body?.status === true,
    providers: Array.isArray(body?.providers) ? body.providers : [],
  };
}

function runPath(runId: string): string {
  return `${RUNS_ENDPOINT}/${encodeURIComponent(runId)}`;
}

function isUnsupportedEndpointError(error: HttpClientError): boolean {
  if (error instanceof AccessDeniedError) {
    return error.status === HTTP_STATUS_NOT_FOUND || error.status === HTTP_STATUS_FORBIDDEN;
  }
  return error instanceof UnexpectedApiError && error.status === HTTP_STATUS_METHOD_NOT_ALLOWED;
}

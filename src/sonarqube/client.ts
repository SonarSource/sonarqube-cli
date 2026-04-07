/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// SonarQube API HTTP client

import { version as VERSION } from '../../package.json';
import { isSonarQubeCloud, resolveFromEndpoint } from '../lib/auth-resolver';
import { SONARCLOUD_API_URL, SONARCLOUD_URL, SONARCLOUD_US_URL } from '../lib/config-constants.js';
import { print } from '../ui';

const GET_REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const POST_REQUEST_TIMEOUT_MS = 60000; // 60 seconds for analysis
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;

export const GENERIC_HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
export const METHODS_WITH_BODY = new Set<HttpMethod>(['POST', 'PATCH', 'PUT']);
export type HttpMethod = (typeof GENERIC_HTTP_METHODS)[number];

export class SonarQubeClient {
  private readonly serverURL: string;
  private readonly token: string;
  public readonly isCloud: boolean;

  constructor(serverURL: string, token: string) {
    this.serverURL = serverURL.replace(/\/$/, ''); // Remove trailing slash
    this.token = token;
    this.isCloud = serverURL.includes(SONARCLOUD_URL) || serverURL.includes(SONARCLOUD_US_URL);
  }

  private commonHeaders(contentType?: 'json' | 'form'): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': `sonarqube-cli/${VERSION}`,
      Accept: 'application/json',
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (contentType === 'form') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (contentType === 'json') {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  private async raiseForStatus(response: Response, method: HttpMethod) {
    if (method === 'GET') {
      if (!response.ok) {
        if (
          response.status === HTTP_STATUS_FORBIDDEN ||
          response.status === HTTP_STATUS_NOT_FOUND
        ) {
          throw new Error(
            `Access denied (HTTP ${response.status}). Check that the supplied token and organization are valid.`,
          );
        }
        throw new Error(`SonarQube API error: ${response.status} ${response.statusText}`);
      }
    } else if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `SonarQube API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }
  }

  /**
   * genericRequest is a generic method to make arbitrary HTTP requests.
   * It should ONLY be used for the `sonar api` command.
   */
  async genericRequest(
    method: HttpMethod,
    endpoint: string,
    data?: string,
    contentType: 'json' | 'form' = 'json',
    debug?: boolean,
  ) {
    const headers = this.commonHeaders(contentType);
    let requestBody: string | undefined;

    if (data && METHODS_WITH_BODY.has(method)) {
      if (contentType === 'form') {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(parsed)) {
          params.set(key, String(value));
        }
        requestBody = params.toString();
      } else {
        requestBody = data;
      }
    }

    const timeout = method === 'GET' ? GET_REQUEST_TIMEOUT_MS : POST_REQUEST_TIMEOUT_MS;

    const transformedServerURL = resolveFromEndpoint(this.serverURL, endpoint);
    const url = `${transformedServerURL}${endpoint}`;

    if (debug) {
      print(`request method: ${method}`, process.stderr);
      print(`request url: ${url}`, process.stderr);
      print(`request headers: ${JSON.stringify(redactSensitiveHeaders(headers))}`, process.stderr);
      print(`request body: ${requestBody}`, process.stderr);
    }

    const response = await fetch(url, {
      method,
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(timeout),
    });

    if (debug) {
      print(`response status: ${response.status}`, process.stderr);
      print(`response headers: ${JSON.stringify(response.headers)}`, process.stderr);
    }

    await this.raiseForStatus(response, method);

    return await response.text();
  }

  /**
   * Make GET request to SonarQube API
   */
  async get<T>(
    endpoint: string,
    params?: Record<string, string | number | boolean>,
    baseUrl?: string,
  ): Promise<T> {
    const url = new URL(`${baseUrl ?? this.serverURL}${endpoint}`);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, String(value));
      });
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.commonHeaders(),
      signal: AbortSignal.timeout(GET_REQUEST_TIMEOUT_MS),
    });

    await this.raiseForStatus(response, 'GET');

    return (await response.json()) as T;
  }

  /**
   * Make POST request to SonarQube API using Bearer token
   */
  async post<T>(endpoint: string, body: unknown, baseUrl?: string): Promise<T> {
    const url = `${baseUrl ?? this.serverURL}${endpoint}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: this.commonHeaders('json'),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_REQUEST_TIMEOUT_MS),
    });

    await this.raiseForStatus(response, 'POST');

    return (await response.json()) as T;
  }

  /**
   * Validate authentication token
   */
  async validateToken(): Promise<boolean> {
    try {
      const result = await this.get<{ valid: boolean }>('/api/authentication/validate');
      return result.valid;
    } catch {
      return false;
    }
  }

  /**
   * Get server system status
   */
  async getSystemStatus(): Promise<{ status: string; version: string; id?: string }> {
    return await this.get('/api/system/status');
  }

  /**
   * Get the current authenticated user
   */
  async getCurrentUser(): Promise<{ id: string } | null> {
    try {
      return await this.get<{ id: string }>('/api/users/current');
    } catch {
      return null;
    }
  }

  /**
   * Get an organization by key and return its server-side UUID (uuidV4).
   * Uses the api.sonarcloud.io/organizations/organizations endpoint (SonarQube Cloud only).
   */
  async getOrganizationId(organizationKey: string): Promise<string | null> {
    try {
      const result = await this.get<Array<{ id: string; uuidV4: string }>>(
        '/organizations/organizations',
        { organizationKey, excludeEligibility: 'true' },
        SONARCLOUD_API_URL,
      );
      return result[0]?.uuidV4 ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Check if an organization has SQAA entitlement.
   * Returns true only when both eligible and enabled are true.
   */
  async checkSqaaEntitlement(organizationUuid: string): Promise<boolean> {
    try {
      const result = await this.get<{ id: string; enabled: boolean; eligible: boolean }>(
        `/a3s-analysis/org-config/${organizationUuid}`,
        undefined,
        SONARCLOUD_API_URL,
      );
      return result.eligible && result.enabled;
    } catch {
      return false;
    }
  }

  /**
   * Convenience: resolve org UUID then check SQAA entitlement in one call.
   */
  async hasSqaaEntitlement(organizationKey?: string): Promise<boolean> {
    if (!organizationKey || !isSonarQubeCloud(this.serverURL)) {
      return false;
    }

    const uuid = await this.getOrganizationId(organizationKey);
    if (!uuid) {
      return false;
    }

    return this.checkSqaaEntitlement(uuid);
  }

  async listUserOrganizations(): Promise<{
    organizations: Array<{ key: string; name: string }>;
    total: number;
  }> {
    try {
      const result = await this.get<{
        organizations: Array<{ key: string; name: string }>;
        paging: { total: number };
      }>('/api/organizations/search', { member: true, ps: 10 });
      return { organizations: result.organizations, total: result.paging.total };
    } catch {
      return { organizations: [], total: 0 };
    }
  }

  /**
   * Check if component (project) exists
   */
  async checkComponent(componentKey: string): Promise<boolean> {
    try {
      await this.get('/api/components/show', { component: componentKey });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if organization exists and is accessible
   */
  async checkOrganization(organizationKey: string): Promise<boolean> {
    try {
      const result = await this.get<{ organizations: Array<{ key: string }> }>(
        '/api/organizations/search',
        {
          organizations: organizationKey,
        },
      );
      return result.organizations.some((org) => org.key === organizationKey);
    } catch {
      return false;
    }
  }

  /**
   * Check if quality profiles are accessible for project
   */
  async checkQualityProfiles(projectKey: string, organizationKey?: string): Promise<boolean> {
    try {
      const params: Record<string, string> = { project: projectKey };
      if (organizationKey) {
        params.organization = organizationKey;
      }
      await this.get('/api/qualityprofiles/search', params);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run SQAA server-side analysis on a single file.
   * SonarQube Cloud only — endpoint lives on api.sonarcloud.io.
   */
  async analyzeFile(request: SqaaAnalysisRequest): Promise<SqaaAnalysisResponse> {
    return await this.post<SqaaAnalysisResponse>(
      '/a3s-analysis/analyses',
      request,
      SONARCLOUD_API_URL,
    );
  }
}

function redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  if (headers.Authorization) {
    return { ...headers, Authorization: 'REDACTED' };
  }
  return headers;
}

export interface SqaaAnalysisRequest {
  organizationKey: string;
  projectKey: string;
  branchName?: string;
  filePath: string;
  fileContent: string;
  fileScope?: 'MAIN' | 'TEST';
}

export interface SqaaAnalysisResponse {
  id: string;
  issues: SqaaIssue[];
  patchResult?: {
    newIssues: SqaaIssue[];
    matchedIssues: SqaaIssue[];
    closedIssues: string[];
  } | null;
  errors?: Array<{ code: string; message: string }> | null;
}

export interface SqaaIssue {
  id: string;
  filePath?: string | null;
  message: string;
  rule: string;
  textRange?: {
    startLine: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
  } | null;
  flows?: Array<{
    type: string;
    description?: string | null;
    locations: Array<{
      textRange?: { startLine: number; endLine: number } | null;
      message?: string | null;
      file?: string | null;
    }>;
  }> | null;
}

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
import { SONARCLOUD_API_URL } from '../lib/config-constants.js';

const GET_REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const POST_REQUEST_TIMEOUT_MS = 60000; // 60 seconds for analysis
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;

export class SonarQubeClient {
  private readonly serverURL: string;
  private readonly token: string;

  constructor(serverURL: string, token: string) {
    this.serverURL = serverURL.replace(/\/$/, ''); // Remove trailing slash
    this.token = token;
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
      headers: {
        Authorization: `Bearer ${this.token}`,
        'User-Agent': `sonarqube-cli/${VERSION}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(GET_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === HTTP_STATUS_FORBIDDEN || response.status === HTTP_STATUS_NOT_FOUND) {
        throw new Error(
          `Access denied (HTTP ${response.status}). Check that the supplied token and organization are valid.`,
        );
      }
      throw new Error(`SonarQube API error: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as T;
  }

  /**
   * Make POST request to SonarQube API using Bearer token
   */
  async post<T>(endpoint: string, body: unknown, baseUrl?: string): Promise<T> {
    const url = `${baseUrl ?? this.serverURL}${endpoint}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': `sonarqube-cli/${VERSION}`,
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `SonarQube API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

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
   * Check if an organization has A3S entitlement.
   * Returns true only when both eligible and enabled are true.
   */
  async checkA3sEntitlement(organizationUuid: string): Promise<boolean> {
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
   * Convenience: resolve org UUID then check A3S entitlement in one call.
   */
  async hasA3sEntitlement(organizationKey: string): Promise<boolean> {
    const uuid = await this.getOrganizationId(organizationKey);
    if (!uuid) return false;
    return this.checkA3sEntitlement(uuid);
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
   * Run A3S server-side analysis on a single file.
   * SonarQube Cloud only — endpoint lives on api.sonarcloud.io.
   */
  async analyzeFile(request: A3sAnalysisRequest): Promise<A3sAnalysisResponse> {
    return await this.post<A3sAnalysisResponse>(
      '/a3s-analysis/analyses',
      request,
      SONARCLOUD_API_URL,
    );
  }
}

export interface A3sAnalysisRequest {
  organizationKey: string;
  projectKey: string;
  branchName?: string;
  filePath: string;
  fileContent: string;
  fileScope?: 'MAIN' | 'TEST';
}

export interface A3sAnalysisResponse {
  id: string;
  issues: A3sIssue[];
  patchResult?: {
    newIssues: A3sIssue[];
    matchedIssues: A3sIssue[];
    closedIssues: string[];
  } | null;
  errors?: Array<{ code: string; message: string }> | null;
}

export interface A3sIssue {
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

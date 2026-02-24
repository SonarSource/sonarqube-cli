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
import logger from '../lib/logger.js';

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
  async post<T>(endpoint: string, body: unknown): Promise<T> {
    const url = `${this.serverURL}${endpoint}`;

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
   * Get an organization by key and return its server-side UUID.
   * Uses the api.sonarcloud.io/organizations endpoint (SonarQube Cloud only).
   */
  async getOrganizationId(organizationKey: string): Promise<string | null> {
    try {
      const result = await this.get<{ id: string }>(
        '/organizations',
        { organizationKey },
        SONARCLOUD_API_URL,
      );
      return result.id;
    } catch {
      return null;
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
   * Get list of organizations for current user
   */
  async getOrganizations(): Promise<Array<{ key: string; name: string }>> {
    try {
      const result = await this.get<{ organizations?: Array<{ key: string; name: string }> }>(
        '/api/organizations',
      );
      return result.organizations ?? [];
    } catch (error) {
      logger.debug(
        '[DEBUG] Failed to get organizations:',
        error instanceof Error ? error.message : String(error),
      );
      return [];
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
}

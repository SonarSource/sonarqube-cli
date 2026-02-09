// SonarQube API HTTP client

import type { IssuesSearchParams, IssuesSearchResponse } from '../lib/types.js';
import { VERSION } from '../version.js';

export class SonarQubeClient {
  private serverURL: string;
  private token: string;
  private organization?: string;

  constructor(serverURL: string, token: string, organization?: string) {
    this.serverURL = serverURL.replace(/\/$/, ''); // Remove trailing slash
    this.token = token;
    this.organization = organization;
  }

  /**
   * Make GET request to SonarQube API
   */
  async get<T>(endpoint: string, params?: Record<string, string | number | boolean>): Promise<T> {
    const url = new URL(`${this.serverURL}${endpoint}`);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    // SonarQube uses Basic Auth with token as username, empty password
    const authHeader = 'Basic ' + Buffer.from(this.token + ':').toString('base64');

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'User-Agent': `sonar-cli/${VERSION}`,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(30000) // 30s timeout
    });

    if (!response.ok) {
      throw new Error(`SonarQube API error: ${response.status} ${response.statusText}`);
    }

    return await response.json() as T;
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
  async getSystemStatus(): Promise<{ status: string; version: string }> {
    return await this.get('/api/system/status');
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
      const result = await this.get<{ organizations: Array<{ key: string; name: string }> }>('/api/organizations');
      return result.organizations || [];
    } catch (error) {
      console.error('[DEBUG] Failed to get organizations:', error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  /**
   * Check if organization exists and is accessible
   */
  async checkOrganization(organizationKey: string): Promise<boolean> {
    try {
      const result = await this.get<{ organizations: Array<{ key: string }> }>('/api/organizations/search', {
        organizations: organizationKey
      });
      return result.organizations.some(org => org.key === organizationKey);
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

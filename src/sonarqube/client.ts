// SonarQube API HTTP client

import { VERSION } from '../version.js';
import logger from '../lib/logger.js';

const GET_REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const POST_REQUEST_TIMEOUT_MS = 60000; // 60 seconds for analysis

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
  async get<T>(endpoint: string, params?: Record<string, string | number | boolean>): Promise<T> {
    const url = new URL(`${this.serverURL}${endpoint}`);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'User-Agent': `sonarqube-cli/${VERSION}`,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(GET_REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`SonarQube API error: ${response.status} ${response.statusText}`);
    }

    return await response.json() as T;
  }

  /**
   * Make POST request to SonarQube API using Bearer token
   */
  async post<T>(endpoint: string, body: unknown): Promise<T> {
    const url = `${this.serverURL}${endpoint}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': `sonarqube-cli/${VERSION}`,
        'Accept': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`SonarQube API error: ${response.status} ${response.statusText} - ${errorText}`);
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
      logger.debug('[DEBUG] Failed to get organizations:', error instanceof Error ? error.message : String(error));
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

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

// SonarQube API HTTP client

import { version as VERSION } from '../../package.json';
import { isSonarQubeCloud, resolveFromEndpoint } from '../lib/auth-resolver';
import { buildFetchInit, fetchGuarded } from '../lib/fetch-guarded.js';
import logger from '../lib/logger';
import { print } from '../ui';
import {
  RateLimitError,
  RequestPayloadTooLargeError,
  type RequestPayloadTooLargeMeta,
  ServiceUnavailableError,
} from './errors';
import { stripGitRemoteUrlUserinfo } from './git-remote-url';
import type { SettingsValue } from './settings-value';

const GET_REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const POST_REQUEST_TIMEOUT_MS = 60000; // 60 seconds for analysis
/** Best-effort token revocation should fail fast when the server is unreachable. */
const REVOKE_USER_TOKEN_TIMEOUT_MS = 10_000;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;

export const GENERIC_HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
export const METHODS_WITH_BODY = new Set<HttpMethod>(['POST', 'PATCH', 'PUT']);
export type HttpMethod = (typeof GENERIC_HTTP_METHODS)[number];

export type CagEntitlementStatus = 'allowed' | 'not_allowed' | 'check_failed';

export type SqaaEntitlementStatus = 'enabled' | 'not_enabled' | 'check_failed';

export class SonarQubeClient {
  private readonly serverURL: string;
  private readonly token: string;
  public readonly isCloud: boolean;
  private readonly orgIdCache = new Map<string, Promise<string | null>>();

  constructor(serverURL: string, token: string) {
    this.serverURL = serverURL.replace(/\/$/, ''); // Remove trailing slash
    this.token = token;
    this.isCloud = isSonarQubeCloud(serverURL);
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
    if (response.ok) return;

    // Status-specific typed errors apply regardless of HTTP method.
    if (response.status === HTTP_STATUS_TOO_MANY_REQUESTS) {
      throw new RateLimitError();
    }
    if (response.status === HTTP_STATUS_SERVICE_UNAVAILABLE) {
      throw new ServiceUnavailableError();
    }
    if (method === 'POST' && response.status === HTTP_STATUS_PAYLOAD_TOO_LARGE) {
      throw await parseRequestPayloadTooLargeError(response);
    }

    if (method === 'GET') {
      if (response.status === HTTP_STATUS_FORBIDDEN || response.status === HTTP_STATUS_NOT_FOUND) {
        throw new Error(
          `Access denied (HTTP ${response.status}). Check that the supplied token and organization are valid.`,
        );
      }
      throw new Error(`SonarQube API error: ${response.status} ${response.statusText}`);
    }

    const errorText = await response.text();
    throw new Error(
      `SonarQube API error: ${response.status} ${response.statusText} - ${errorText}`,
    );
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
      print(`request method: ${method}`, 'stderr');
      print(`request url: ${url}`, 'stderr');
      print(`request headers: ${JSON.stringify(redactSensitiveHeaders(headers))}`, 'stderr');
      print(`request body: ${requestBody}`, 'stderr');
    }

    const response = await fetchGuarded(url, buildFetchInit(method, headers, timeout, requestBody));

    if (debug) {
      print(`response status: ${response.status}`, 'stderr');
      print(`response headers: ${JSON.stringify(response.headers)}`, 'stderr');
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
    const result = await this.getSafe<T>(endpoint, params, baseUrl);

    await this.raiseForStatus(result.response, 'GET');

    return result.value!;
  }

  // false positive
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async getSafe<TValue>(
    endpoint: string,
    params?: Record<string, string | number | boolean>,
    baseUrl?: string,
  ): Promise<{ response: Response; value: TValue | undefined }> {
    const url = new URL(`${baseUrl ?? this.serverURL}${endpoint}`);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, String(value));
      });
    }

    const response = await fetchGuarded(
      url.toString(),
      buildFetchInit('GET', this.commonHeaders(), GET_REQUEST_TIMEOUT_MS),
    );

    const value = response.ok ? ((await response.json()) as TValue) : undefined;

    return { response, value };
  }

  /**
   * Make POST request to SonarQube API using Bearer token
   */
  async post<T>(endpoint: string, body: unknown, baseUrl?: string): Promise<T> {
    const url = `${baseUrl ?? this.serverURL}${endpoint}`;

    const response = await fetchGuarded(
      url,
      buildFetchInit(
        'POST',
        this.commonHeaders('json'),
        POST_REQUEST_TIMEOUT_MS,
        JSON.stringify(body),
      ),
    );

    await this.raiseForStatus(response, 'POST');

    return (await response.json()) as T;
  }

  /**
   * Generic helper to POST a form-encoded body to a SonarQube endpoint using
   * the configured Bearer token. Throws on non-2xx responses so callers can
   * handle failures (e.g. best-effort logout).
   */
  async postForm(
    endpoint: string,
    params: Record<string, string>,
    timeoutMs: number = POST_REQUEST_TIMEOUT_MS,
  ): Promise<void> {
    const response = await fetchGuarded(
      `${this.serverURL}${endpoint}`,
      buildFetchInit(
        'POST',
        this.commonHeaders('form'),
        timeoutMs,
        new URLSearchParams(params).toString(),
      ),
    );

    await this.raiseForStatus(response, 'POST');
  }

  /**
   * Revoke a user token on the server by its name.
   *
   * The wire field is `name` (matches the `/api/user_tokens/revoke?name=`
   * contract). Internally we keep the field as `tokenName` on `AuthConnection`
   * to disambiguate from other "name" fields in the state (project name,
   * org name, etc.). The translation happens here at the wire boundary.
   */
  async revokeUserToken(tokenName: string): Promise<void> {
    await this.postForm(
      '/api/user_tokens/revoke',
      { name: tokenName },
      REVOKE_USER_TOKEN_TIMEOUT_MS,
    );
  }

  async checkTokenValidity(): Promise<'valid' | 'invalid'> {
    const result = await this.get<{ valid: boolean }>('/api/authentication/validate');
    return result.valid ? 'valid' : 'invalid';
  }

  async getServerMode(): Promise<'mqr' | 'standard'> {
    if (this.isCloud) return 'mqr';
    const { response, value } = await this.getSafe<{ mode: string }>(
      '/api/v2/clean-code-policy/mode',
    );
    if (response.status === HTTP_STATUS_NOT_FOUND) return 'standard';
    await this.raiseForStatus(response, 'GET');
    return value?.mode === 'MQR' ? 'mqr' : 'standard';
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
   * Uses the region-specific Cloud API host (SonarQube Cloud only).
   */
  async getOrganizationId(organizationKey: string): Promise<string | null> {
    let pending = this.orgIdCache.get(organizationKey);
    if (!pending) {
      pending = this.fetchOrganizationId(organizationKey);
      this.orgIdCache.set(organizationKey, pending);
    }
    return pending;
  }

  private async fetchOrganizationId(organizationKey: string): Promise<string | null> {
    try {
      const endpoint = '/organizations/organizations';
      const result = await this.get<Array<{ id: string; uuidV4: string }>>(
        endpoint,
        { organizationKey, excludeEligibility: 'true' },
        resolveFromEndpoint(this.serverURL, endpoint),
      );
      return result[0]?.uuidV4 ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Check if an organization has SQAA entitlement.
   * Returns `'enabled'` only when both eligible and enabled are true, `'not_enabled'`
   * for a definitive negative answer, and `'check_failed'` when the API call errors out.
   */
  async checkSqaaEntitlement(organizationUuid: string): Promise<SqaaEntitlementStatus> {
    try {
      const endpoint = `/a3s-analysis/org-config/${organizationUuid}`;
      const result = await this.get<{ id: string; enabled: boolean; eligible: boolean }>(
        endpoint,
        undefined,
        resolveFromEndpoint(this.serverURL, endpoint),
      );
      return result.eligible && result.enabled ? 'enabled' : 'not_enabled';
    } catch {
      return 'check_failed';
    }
  }

  /**
   * Query Sonar Advanced Security (SCA) enablement on the connected server.
   * SonarCloud exposes this at `/sca/feature-enabled?organization=<key>`
   * (api.sonarcloud.io); SonarQube Server at `/api/v2/sca/feature-enabled`.
   *
   * Returns a 3-state value so callers can distinguish "not enabled" (a definitive
   * answer from the server) from "check_failed" (network error, unreachable, etc.).
   */
  async getScaEnablement(
    connectionType: 'cloud' | 'on-premise',
    orgKey?: string,
  ): Promise<'enabled' | 'not_enabled' | 'check_failed'> {
    try {
      const isCloud = connectionType === 'cloud';
      const endpoint = isCloud ? '/sca/feature-enabled' : '/api/v2/sca/feature-enabled';
      const params = isCloud && orgKey ? { organization: orgKey } : undefined;
      const result = await this.get<{ enabled: boolean }>(
        endpoint,
        params,
        resolveFromEndpoint(this.serverURL, endpoint),
      );
      return result.enabled ? 'enabled' : 'not_enabled';
    } catch {
      return 'check_failed';
    }
  }

  /**
   * Boolean wrapper over getScaEnablement for callers that gate on "enabled" only.
   * Any failure (404, network, unauthorized, not enabled) is treated as "not available".
   */
  async checkScaEnabled(connectionType: 'cloud' | 'on-premise', orgKey?: string): Promise<boolean> {
    return (await this.getScaEnablement(connectionType, orgKey)) === 'enabled';
  }

  /**
   * Convenience: resolve org UUID then check SQAA entitlement in one call.
   */
  async hasSqaaEntitlement(organizationKey?: string): Promise<SqaaEntitlementStatus> {
    if (!organizationKey || !isSonarQubeCloud(this.serverURL)) {
      return 'not_enabled';
    }

    const uuid = await this.getOrganizationId(organizationKey);
    if (!uuid) {
      return 'check_failed';
    }

    return this.checkSqaaEntitlement(uuid);
  }

  async checkCagEntitlement(organizationUuid: string): Promise<CagEntitlementStatus> {
    try {
      const endpoint = `/a3s-analysis/cag-entitlement/${organizationUuid}`;
      const result = await this.get<{ allowed: boolean; consumption?: object }>(
        endpoint,
        undefined,
        resolveFromEndpoint(this.serverURL, endpoint),
      );
      return result.allowed ? 'allowed' : 'not_allowed';
    } catch {
      return 'check_failed';
    }
  }

  async hasCagEntitlement(organizationKey?: string): Promise<CagEntitlementStatus> {
    if (!organizationKey || !isSonarQubeCloud(this.serverURL)) {
      return 'not_allowed';
    }
    const uuid = await this.getOrganizationId(organizationKey);
    if (!uuid) {
      return 'check_failed';
    }
    return this.checkCagEntitlement(uuid);
  }

  async checkAiRemediationEntitlement(
    orgKey: string,
  ): Promise<{ status: 'not_eligible' | 'not_enabled' | 'ok' | 'unknown' }> {
    try {
      const orgsEndpoint = '/organizations/organizations';
      const orgs = await this.get<Array<{ id: string; uuidV4: string; name?: string }>>(
        orgsEndpoint,
        { organizationKey: orgKey, excludeEligibility: 'true' },
        resolveFromEndpoint(this.serverURL, orgsEndpoint),
      );
      const org = orgs.at(0);
      if (!org) return { status: 'not_eligible' };

      const configEndpoint = `/fix-suggestions/organization-configs/${org.id}`;
      const config = await this.get<{
        codeReviewAgent: { organizationEligible: boolean; delegateIssuesEnabled?: boolean };
      }>(configEndpoint, undefined, resolveFromEndpoint(this.serverURL, configEndpoint));

      if (!config.codeReviewAgent.organizationEligible) return { status: 'not_eligible' };
      if (!config.codeReviewAgent.delegateIssuesEnabled) return { status: 'not_enabled' };
      return { status: 'ok' };
    } catch (err) {
      logger.warn('AI remediation entitlement check failed', err);
      return { status: 'unknown' };
    }
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
   * Fetch project-scoped settings via `/api/settings/values`. The `component`
   * query param scopes the values to a specific project; without it the API
   * returns global defaults. Callers project the raw entries into whatever
   * shape they need (e.g. `parseAnalysisProperties` for SCA).
   */
  async getProjectSettings(projectKey: string): Promise<SettingsValue[]> {
    const result = await this.getSafe<{ settings?: SettingsValue[] }>('/api/settings/values', {
      component: projectKey,
    });

    if (result.response.status === HTTP_STATUS_NOT_FOUND) {
      throw new Error(`Project ${projectKey} not found`);
    }

    await this.raiseForStatus(result.response, 'GET');

    return result.value?.settings ?? [];
  }

  /**
   * Resolve a project key from a git repository remote URL using server-side bindings.
   * SonarQube Server: GET /api/v2/dop-translation/project-bindings
   * SonarQube Cloud: GET /dop-translation/project-bindings, then search_projects by project id.
   */
  async getProjectKeyByGitRemote(remoteUrl: string, orgKey?: string): Promise<string | null> {
    const sanitizedRemoteUrl = stripGitRemoteUrlUserinfo(remoteUrl);
    if (this.isCloud) {
      if (!orgKey) {
        return null;
      }
      const projectId = await this.getSqcProjectIdByRemoteUrl(sanitizedRemoteUrl);
      if (!projectId) {
        return null;
      }
      return this.getSonarCloudProjectKeyById(projectId, orgKey);
    }
    const binding = await this.getSqsProjectBindingByRemoteUrl(sanitizedRemoteUrl);
    return binding?.projectKey ?? null;
  }

  private async getSqsProjectBindingByRemoteUrl(
    remoteUrl: string,
  ): Promise<{ projectKey: string } | null> {
    const endpoint = `/api/v2/dop-translation/project-bindings?repositoryUrl=${encodeURIComponent(remoteUrl)}`;
    const result = await this.getSafe<{
      projectBindings: Array<{ projectId: string; projectKey: string }>;
    }>(endpoint);
    if (!result.response.ok) {
      return null;
    }
    const binding = requireSingleBinding(
      result.value?.projectBindings,
      'git remote on SonarQube Server',
    );
    return binding?.projectKey ? { projectKey: binding.projectKey } : null;
  }

  private async getSqcProjectIdByRemoteUrl(remoteUrl: string): Promise<string | null> {
    const endpoint = `/dop-translation/project-bindings?url=${encodeURIComponent(remoteUrl)}`;
    const apiHost = resolveFromEndpoint(this.serverURL, endpoint);
    const result = await this.getSafe<{ bindings: Array<{ projectId: string }> }>(
      endpoint,
      undefined,
      apiHost,
    );
    if (!result.response.ok) {
      return null;
    }
    const binding = requireSingleBinding(result.value?.bindings, 'git remote on SonarQube Cloud');
    return binding?.projectId ?? null;
  }

  private async getSonarCloudProjectKeyById(
    projectId: string,
    orgKey: string,
  ): Promise<string | null> {
    const result = await this.getSafe<{ components: Array<{ key: string }> }>(
      '/api/components/search_projects',
      { projectIds: projectId, organization: orgKey },
    );
    if (!result.response.ok) {
      return null;
    }
    const components = result.value?.components;
    if (!Array.isArray(components) || components.length === 0) {
      return null;
    }
    const projectKey = components[0].key;
    return projectKey || null;
  }

  /**
   * Check if component (project) exists
   */
  async checkComponent(projectKey: string): Promise<boolean> {
    try {
      await this.get('/api/components/show', { component: projectKey });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Return the legacy alphanumeric ID for a project component key.
   * The external AI agents API expects this ID (not the human-readable key) as `projectId`.
   * Uses /api/navigation/component - same endpoint the web UI uses; `id` is always present there.
   */
  async getComponentId(componentKey: string): Promise<string | null> {
    try {
      const result = await this.get<{ id: string }>('/api/navigation/component', {
        component: componentKey,
      });
      return result.id;
    } catch {
      return null;
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
   * Schedule an AI agent remediation job for a set of issues.
   * SonarQube Cloud only - endpoint lives on the region-specific API host.
   */
  async scheduleAgentJob(request: AgentJobRequest): Promise<AgentJobResponse> {
    const endpoint = '/fix-suggestions/ai-agent-scheduled-jobs';
    return await this.post<AgentJobResponse>(
      endpoint,
      request,
      resolveFromEndpoint(this.serverURL, endpoint),
    );
  }

  /**
   * Create a SonarQube Agentic Analysis (single- or multi-file).
   * SonarQube Cloud only — endpoint lives on the region-specific API host.
   */
  async createAnalysis(request: SqaaAnalysisRequest): Promise<SqaaAnalysisResponse> {
    const endpoint = '/a3s-analysis/analyses';
    return await this.post<SqaaAnalysisResponse>(
      endpoint,
      request,
      resolveFromEndpoint(this.serverURL, endpoint),
    );
  }
}

/** Returns the sole binding, or null when there are none or more than one (ambiguous). */
function requireSingleBinding<T>(bindings: T[] | undefined, context: string): T | null {
  if (!bindings?.length) {
    return null;
  }
  if (bindings.length > 1) {
    logger.debug(
      `Multiple project bindings (${bindings.length}) for ${context}; skipping ambiguous git remote auto-discovery`,
    );
    return null;
  }
  return bindings[0];
}

function redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  if (headers.Authorization) {
    return { ...headers, Authorization: 'REDACTED' };
  }
  return headers;
}

async function parseRequestPayloadTooLargeError(
  response: Response,
): Promise<RequestPayloadTooLargeError> {
  const fallback = new RequestPayloadTooLargeError(
    `SonarQube API error: ${response.status} ${response.statusText}`,
  );
  try {
    const body = (await response.json()) as {
      message?: string;
      code?: string;
      meta?: RequestPayloadTooLargeMeta;
    };
    const message =
      body.message ?? `SonarQube API error: ${response.status} ${response.statusText}`;
    const code =
      body.code === 'REQUEST_TOO_LARGE' || body.code === 'TOO_MANY_FILES' ? body.code : undefined;
    return new RequestPayloadTooLargeError(message, code, body.meta);
  } catch {
    return fallback;
  }
}

export interface AgentJobRequest {
  projectId: string;
  issueKeys: string[];
  triggerSource: 'CLI';
}

export interface AgentJobResponse {
  taskId: string;
}

export type SqaaAnalysisDepth = 'STANDARD' | 'DEEP';

export type SqaaFileScope = 'MAIN' | 'TEST';

export interface SqaaAnalysisFile {
  path: string;
  content: string;
  scope?: SqaaFileScope;
}

export interface SqaaAnalysisRequest {
  organizationKey: string;
  projectKey: string;
  branchName?: string;
  files: SqaaAnalysisFile[];
  analysisDepth?: SqaaAnalysisDepth;
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

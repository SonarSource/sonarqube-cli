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

import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_PAYLOAD_TOO_LARGE,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
} from '@/core/http-constants.ts';
import { INVOCATION_ID, SONAR_INVOCATION_ID_HEADER } from '@/core/telemetry/invocation-id.ts';
import { print } from '@/core/ui';

import { version as VERSION } from '../../../package.json';
import logger from '../observability/logger.ts';
import {
  BadRequestError,
  ForbiddenApiError,
  RateLimitError,
  RequestPayloadTooLargeError,
  type RequestPayloadTooLargeMeta,
  ServiceUnavailableError,
  SqaaForbiddenError,
} from './errors.ts';
import { buildRequest, fetchAuthenticated } from './fetch.ts';
import { stripGitRemoteUrlUserinfo } from './git-remote-url.ts';
import type { SettingsValue } from './settings-value.ts';
import {
  isSonarQubeCloud,
  normalizeCloudV2Endpoint,
  resolveFromEndpoint,
} from './sonarcloud-region.ts';

const GET_REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const POST_REQUEST_TIMEOUT_MS = 60000; // 60 seconds for analysis
/** Best-effort token revocation should fail fast when the server is unreachable. */
const REVOKE_USER_TOKEN_TIMEOUT_MS = 10_000;

export const GENERIC_HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
export const METHODS_WITH_BODY = new Set<HttpMethod>(['POST', 'PATCH', 'PUT']);
export type HttpMethod = (typeof GENERIC_HTTP_METHODS)[number];
export type QueryParams = Record<string, string | number | boolean>;

/**
 * `not_applicable` is returned when Vortex cannot apply to this connection: Cloud without
 * an organization (see `resolveVortexEntitlement`), or a Server missing either hub (HTTP 404).
 */
export type VortexEntitlementStatus =
  'enabled' | 'over_consumption' | 'not_entitled' | 'check_failed' | 'not_applicable';

/**
 * Server has no organizations, but entitlement lives on `/…/{id}` — omitting the
 * segment 404s. The nil UUID is a valid UUID the CLI can send without knowing
 * Server's default-org id (a backend internal). CAG's `@OrganizationId` overwrites
 * it; A3S parses then ignores it.
 */
export const SERVER_ORGANIZATION_ID_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

export interface VortexEntitlementResult {
  status: VortexEntitlementStatus;
  consumption?: { consumed: number; limit: number };
}

export interface Organization {
  key: string;
  name: string;
  alm?: { key: string };
  actions?: { admin: boolean };
  onlyPrivateProjects?: { enabled: boolean };
}

/**
 * Result of an organization lookup: found, absent, or not checkable.
 *
 * Deliberately carries no organization record. Callers only need to know whether the key resolves;
 * the one caller that needs the record itself uses `fetchOrganizationByKey`.
 */
export type OrganizationAccess =
  { status: 'accessible' } | { status: 'not_found' } | { status: 'check_failed'; reason: string };

export interface DopRepository {
  id: string;
  name: string;
  slug: string;
  private: boolean;
  archived: boolean;
  boundProjectIds: string[];
  importedInCurrentOrg: boolean;
}

export interface ProvisionedProject {
  projectKey: string;
}

export class SonarQubeClient {
  private readonly serverURL: string;
  private readonly token: string;
  public readonly isCloud: boolean;
  private readonly orgInfoCache = new Map<string, Promise<{ id: string; uuidV4: string } | null>>();

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
    if (method === 'POST' && response.status === HTTP_STATUS_BAD_REQUEST) {
      throw await parseBadRequestError(response);
    }
    if (method === 'POST' && response.status === HTTP_STATUS_PAYLOAD_TOO_LARGE) {
      throw await parseRequestPayloadTooLargeError(response);
    }
    if (method === 'POST' && response.status === HTTP_STATUS_FORBIDDEN) {
      throw new ForbiddenApiError(await response.text());
    }

    if (method === 'GET') {
      if (response.status === HTTP_STATUS_FORBIDDEN || response.status === HTTP_STATUS_NOT_FOUND) {
        throw new Error(
          `Access denied (HTTP ${response.status}). Check that the supplied token and organization are valid.`,
        );
      }
      const errorText = await response.text();
      logger.debug(`SonarQube GET ${response.url} failed: ${response.status} ${errorText}`);
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

    const normalizedEndpoint = normalizeCloudV2Endpoint(this.serverURL, endpoint);
    const transformedServerURL = resolveFromEndpoint(this.serverURL, normalizedEndpoint);
    const url = `${transformedServerURL}${normalizedEndpoint}`;

    if (debug) {
      print(`request method: ${method}`, 'stderr');
      print(`request url: ${url}`, 'stderr');
      print(`request headers: ${JSON.stringify(redactSensitiveHeaders(headers))}`, 'stderr');
      print(`request body: ${requestBody}`, 'stderr');
    }

    const response = await fetchAuthenticated(
      url,
      buildRequest(method, headers, timeout, requestBody),
    );

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
  async get<T>(endpoint: string, params?: QueryParams, baseUrl?: string): Promise<T> {
    const result = await this.getSafe<T>(endpoint, params, baseUrl);
    return this.unwrapGetResult(result);
  }

  /**
   * Like `get`, but returns `null` instead of throwing when the server responds 404.
   * Every other non-2xx status still raises its normal typed error.
   */
  async getOrNotFound<T>(
    endpoint: string,
    params?: QueryParams,
    baseUrl?: string,
  ): Promise<T | null> {
    const result = await this.getSafe<T>(endpoint, params, baseUrl);

    if (result.response.status === HTTP_STATUS_NOT_FOUND) {
      return null;
    }

    return this.unwrapGetResult(result);
  }

  private async unwrapGetResult<T>(result: {
    response: Response;
    value: T | undefined;
  }): Promise<T> {
    await this.raiseForStatus(result.response, 'GET');

    if (result.value === undefined) {
      throw new Error('SonarQube API error: empty response body');
    }
    return result.value;
  }

  // false positive
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async getSafe<TValue>(
    endpoint: string,
    params?: QueryParams,
    baseUrl?: string,
    timeoutMs: number = GET_REQUEST_TIMEOUT_MS,
  ): Promise<{ response: Response; value: TValue | undefined }> {
    const url = new URL(`${baseUrl ?? this.serverURL}${endpoint}`);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, String(value));
      });
    }

    const urlString = url.toString();
    const response = await fetchAuthenticated(
      urlString,
      buildRequest('GET', this.commonHeaders(), timeoutMs, undefined),
    );

    const value = response.ok ? ((await response.json()) as TValue) : undefined;

    return { response, value };
  }

  /**
   * Make POST request to SonarQube API using Bearer token
   */
  async post<T>(
    endpoint: string,
    body: unknown,
    baseUrl?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${baseUrl ?? this.serverURL}${endpoint}`;
    const headers = { ...this.commonHeaders('json'), ...extraHeaders };

    const response = await fetchAuthenticated(
      url,
      buildRequest('POST', headers, POST_REQUEST_TIMEOUT_MS, JSON.stringify(body)),
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
    const url = `${this.serverURL}${endpoint}`;
    const response = await fetchAuthenticated(
      url,
      buildRequest(
        'POST',
        this.commonHeaders('form'),
        timeoutMs,
        new URLSearchParams(params).toString(),
      ),
    );

    await this.raiseForStatus(response, 'POST');
  }

  /**
   * Like `postForm`, but parses and returns the JSON response body instead of
   * discarding it. Used for legacy endpoints that are
   * form-encoded on the request side but return a JSON body.
   */
  private async postFormJson<T>(endpoint: string, params: Record<string, string>): Promise<T> {
    const url = `${this.serverURL}${endpoint}`;
    const response = await fetchAuthenticated(
      url,
      buildRequest(
        'POST',
        this.commonHeaders('form'),
        POST_REQUEST_TIMEOUT_MS,
        new URLSearchParams(params).toString(),
      ),
    );

    await this.raiseForStatus(response, 'POST');

    return (await response.json()) as T;
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
    const result = await this.getOrNotFound<{ mode: string }>('/api/v2/clean-code-policy/mode');
    return result?.mode === 'MQR' ? 'mqr' : 'standard';
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
    const info = await this.getOrganizationInfo(organizationKey);
    return info?.uuidV4 ?? null;
  }

  /**
   * Get an organization by key and return its legacy alphanumeric ID (not the
   * uuidV4). Some APIs, like dop-translation, key off this legacy ID rather
   * than the uuidV4 (SonarQube Cloud only).
   */
  async getOrganizationLegacyId(organizationKey: string): Promise<string | null> {
    const info = await this.getOrganizationInfo(organizationKey);
    return info?.id ?? null;
  }

  private async getOrganizationInfo(
    organizationKey: string,
  ): Promise<{ id: string; uuidV4: string } | null> {
    let pending = this.orgInfoCache.get(organizationKey);
    if (!pending) {
      pending = this.fetchOrganizationInfo(organizationKey);
      this.orgInfoCache.set(organizationKey, pending);
    }
    return pending;
  }

  private async fetchOrganizationInfo(
    organizationKey: string,
  ): Promise<{ id: string; uuidV4: string } | null> {
    try {
      const endpoint = '/organizations/organizations';
      const result = await this.get<Array<{ id: string; uuidV4: string }>>(
        endpoint,
        { organizationKey, excludeEligibility: 'true' },
        resolveFromEndpoint(this.serverURL, endpoint),
      );
      return result[0] ?? null;
    } catch {
      return null;
    }
  }

  private sqaaEntitlementEndpoint(organizationUuid: string): string {
    return this.isCloud
      ? `/a3s-analysis/org-entitlement/${organizationUuid}`
      : `/api/v2/a3s/org-entitlement/${organizationUuid}`;
  }

  /**
   * Shared entitlement GET. Both hubs return `{ allowed, hasEntitlement }`; CAG may also
   * send `consumption`. Only the path differs. A Server 404 means that hub is not
   * installed. A Cloud 404 is a fault — those services always exist.
   */
  private async checkHubEntitlement(endpoint: string): Promise<VortexEntitlementResult> {
    try {
      const { response, value } = await this.getSafe<{
        allowed?: boolean;
        hasEntitlement?: boolean;
        consumption?: { consumed: number; limit: number };
      }>(endpoint, undefined, resolveFromEndpoint(this.serverURL, endpoint));
      if (response.status === HTTP_STATUS_NOT_FOUND && !this.isCloud) {
        return { status: 'not_applicable' };
      }
      if (!response.ok || value === undefined) {
        return { status: 'check_failed' };
      }
      if (value.allowed) {
        return { status: 'enabled', consumption: value.consumption };
      }
      return {
        status: value.hasEntitlement ? 'over_consumption' : 'not_entitled',
        consumption: value.consumption,
      };
    } catch {
      return { status: 'check_failed' };
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

  private cagEntitlementEndpoint(organizationUuid: string): string {
    return this.isCloud
      ? `/cag/cag-entitlement/${organizationUuid}`
      : `/api/v2/cag/cag-entitlement/${organizationUuid}`;
  }

  /**
   * Vortex is two hubs with no shared backend. Both are probed with the same GET mapper
   * on every connection. Server fills `{id}` with {@link SERVER_ORGANIZATION_ID_PLACEHOLDER}
   * rather than a second org-less route — a valid UUID the CLI can send without
   * knowing Server's default-org id. CAG's `@OrganizationId` rewrites that path; A3S
   * ignores it. See `mergeVortexEntitlement`: either hub
   * missing or unlicensed means Vortex is not available.
   */
  async hasVortexEntitlement(organizationKey?: string): Promise<VortexEntitlementResult> {
    try {
      const uuid = await this.resolveEntitlementOrganizationId(organizationKey);
      if (typeof uuid !== 'string') {
        return uuid;
      }
      const [sqaa, cag] = await Promise.all([
        this.checkHubEntitlement(this.sqaaEntitlementEndpoint(uuid)),
        this.checkHubEntitlement(this.cagEntitlementEndpoint(uuid)),
      ]);
      return mergeVortexEntitlement(sqaa, cag);
    } catch {
      return { status: 'check_failed' };
    }
  }

  /**
   * The organization id both entitlement endpoints are keyed by, or the terminal result
   * when it cannot be resolved. Server has no organizations; the path still requires
   * `{id}`, so we send {@link SERVER_ORGANIZATION_ID_PLACEHOLDER}.
   */
  private async resolveEntitlementOrganizationId(
    organizationKey?: string,
  ): Promise<string | VortexEntitlementResult> {
    if (!this.isCloud) {
      return SERVER_ORGANIZATION_ID_PLACEHOLDER;
    }
    if (!organizationKey) {
      return { status: 'not_entitled' };
    }
    return (await this.getOrganizationId(organizationKey)) ?? { status: 'check_failed' };
  }

  /**
   * Check whether an organization is entitled to a specific billing feature via
   * `GET /billing/entitlements` (SonarQube Cloud only, region-specific API host).
   */
  async checkBillingEntitlement(organizationUuid: string, entitlement: string): Promise<boolean> {
    try {
      const endpoint = '/billing/entitlements';
      const result = await this.get<{ entitlements: Array<{ allowedFeatures: string[] }> }>(
        endpoint,
        { resourceId: organizationUuid, resourceType: 'organization' },
        resolveFromEndpoint(this.serverURL, endpoint),
      );
      return result.entitlements.some((e) => e.allowedFeatures.includes(entitlement));
    } catch (err) {
      logger.debug(`Failed to check '${entitlement}' billing entitlement`, err);
      return false;
    }
  }

  async hasPrivateProjectsEntitlement(organizationKey: string): Promise<boolean> {
    const uuid = await this.getOrganizationId(organizationKey);
    if (!uuid) return false;
    return this.checkBillingEntitlement(uuid, 'privateProjects');
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

  /**
   * List the organizations the caller is a member of.
   *
   * Errors are not swallowed here. An empty list sends the login flow to the manual
   * organization prompt, so a failed request must not look like an empty list.
   */
  async listUserOrganizations(
    page = 1,
    ps = 10,
  ): Promise<{ organizations: Organization[]; total: number }> {
    const result = await this.get<{
      organizations: Organization[];
      paging: { total: number };
    }>('/api/organizations/search', { member: true, ps, p: page });
    return { organizations: result.organizations, total: result.paging.total };
  }

  /** Server-enforced max `pageSize` for `/dop-translation/dop-repositories`. */
  static readonly DOP_REPOSITORIES_MAX_PAGE_SIZE = 50;

  /**
   * Fetch one page of repositories visible to an organization's bound DevOps platform via
   * `/dop-translation/dop-repositories` (SonarQube Cloud only, region-specific API host).
   */
  async fetchDopRepositoriesPage(
    organizationId: string,
    pageIndex: number,
    pageSize: number,
  ): Promise<{ repositories: DopRepository[]; total: number }> {
    const endpoint = '/dop-translation/dop-repositories';
    const result = await this.get<{
      repositories: DopRepository[];
      page: { total: number };
    }>(
      endpoint,
      { organizationId, pageIndex, pageSize },
      resolveFromEndpoint(this.serverURL, endpoint),
    );
    return { repositories: result.repositories, total: result.page.total };
  }

  /**
   * Create (provision) a SonarQube project bound to a single DevOps platform repository via the
   * legacy `POST /api/alm_integration/provision_projects` endpoint (SonarQube Cloud only). This
   * has not migrated to the newer `dop-translation` family yet.
   *
   * `installationKey` must already be in the ALM-specific format the server expects (e.g.
   * `<slug>|<id>` for GitHub, plain `id` for other platforms).
   */
  async provisionProject(
    organization: string,
    installationKey: string,
  ): Promise<{ projects: ProvisionedProject[] }> {
    return await this.postFormJson<{ projects: ProvisionedProject[] }>(
      '/api/alm_integration/provision_projects',
      { organization, installationKeys: installationKey },
    );
  }

  /**
   * Request SonarQube Cloud Autoscan eligibility/auto-enable for a newly provisioned project.
   * Best-effort: swallows failures so a hiccup here never fails the enclosing `sonar import` run.
   */
  async requestAutoscanEligibility(projectKey: string): Promise<void> {
    try {
      await this.get('/api/autoscan/eligibility', {
        autoEnable: true,
        ignoreCache: false,
        projectKey,
      });
    } catch (err) {
      logger.debug('Failed to request autoscan eligibility', err);
      return undefined;
    }
  }

  /**
   * ALM-type lookup via `GET /dop-translation/organization-bindings` (SonarQube Cloud only,
   * region-specific API host), keyed by the org's **legacy** id (not `uuidV4`). Used to format
   * `provision_projects`' `installationKeys` param correctly for the org's connected DevOps
   * platform. Lookup failures are reported to the caller rather than swallowed, so callers can
   * tell them apart from an org that genuinely has no binding.
   */
  async getOrganizationAlmKey(organizationKey: string): Promise<string | undefined> {
    const organizationId = await this.getOrganizationLegacyId(organizationKey);
    if (!organizationId) return undefined;

    const endpoint = '/dop-translation/organization-bindings';
    const result = await this.get<{
      organizationBindings: Array<{ devOpsPlatform: string }>;
    }>(endpoint, { organizationId }, resolveFromEndpoint(this.serverURL, endpoint));
    return result.organizationBindings[0]?.devOpsPlatform;
  }

  /**
   * Fetch project-scoped settings via `/api/settings/values`. The `component`
   * query param scopes the values to a specific project; without it the API
   * returns global defaults. Callers project the raw entries into whatever
   * shape they need (e.g. `parseAnalysisProperties` for SCA).
   */
  async getProjectSettings(projectKey: string): Promise<SettingsValue[]> {
    const result = await this.getOrNotFound<{ settings?: SettingsValue[] }>(
      '/api/settings/values',
      { component: projectKey },
    );

    if (result === null) {
      throw new Error(`Project '${projectKey}' not found`);
    }

    return result.settings ?? [];
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

  // ---------------------------------------------------------------------------
  // Admin / CI setup — SonarQube Server only (SQS v2 endpoints)
  // ---------------------------------------------------------------------------

  async listGitlabDopSettings(): Promise<Array<{ id: string; key: string; url: string }>> {
    const result = await this.get<{
      dopSettings: Array<{ id: string; key: string; type: string; url: string }>;
    }>('/api/v2/dop-translation/dop-settings');
    return result.dopSettings.filter((s) => s.type === 'gitlab');
  }

  // filters by dopSettingId to avoid cross-ALM collisions (GitHub, Azure also populate `repository`)
  async getAllProjectBindings(dopSettingId: string): Promise<Map<string, string>> {
    const bindingMap = new Map<string, string>();
    let pageIndex = 1;
    const pageSize = 500;
    for (;;) {
      const result = await this.get<{
        projectBindings: Array<{ projectKey: string; repository: string }>;
        page: { total: number; pageSize: number; pageIndex: number };
      }>('/api/v2/dop-translation/project-bindings', {
        pageSize,
        pageIndex,
        dopSettingId,
      });
      for (const binding of result.projectBindings) {
        bindingMap.set(binding.repository, binding.projectKey);
      }
      const effectivePageSize = result.page.pageSize || pageSize;
      if (result.projectBindings.length === 0 || pageIndex * effectivePageSize >= result.page.total)
        break;
      pageIndex++;
    }
    return bindingMap;
  }

  async hasProjectBeenAnalyzed(projectKey: string): Promise<boolean> {
    const { response, value } = await this.getSafe<{ analyses?: unknown[] }>(
      '/api/project_analyses/search',
      { project: projectKey, ps: 1 },
    );
    if (response.status === HTTP_STATUS_NOT_FOUND) return false;
    await this.raiseForStatus(response, 'GET');
    return (value?.analyses?.length ?? 0) > 0;
  }

  async hasProvisionProjectsPermission(): Promise<boolean> {
    const result = await this.get<{ permissions?: { global?: string[] } }>('/api/users/current');

    return result.permissions?.global?.includes('provisioning') ?? false;
  }

  /**
   * Like `checkComponent`, but only treats a 404 as "missing" - every other
   * failure (auth, rate limit, outage, network error) propagates as its
   * normal typed error instead of being reported as a missing component.
   */
  async componentExists(projectKey: string): Promise<boolean> {
    const component = await this.getOrNotFound('/api/components/show', { component: projectKey });
    return component !== null;
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
   * Resolve an organization key.
   *
   * `/api/organizations/search` answers an unknown key with `200` and an empty list. An error
   * therefore never means "no such organization", so the two cases are reported apart.
   *
   * The `organizations` filter is not limited to the caller's memberships: it also resolves
   * public organizations. That is why a hand-typed key can be validated with it.
   */
  async resolveOrganizationAccess(organizationKey: string): Promise<OrganizationAccess> {
    try {
      const organization = await this.fetchOrganizationByKey(organizationKey);
      return organization ? { status: 'accessible' } : { status: 'not_found' };
    } catch (error) {
      return { status: 'check_failed', reason: (error as Error).message };
    }
  }

  /**
   * Check if organization exists and is accessible.
   *
   * Use `resolveOrganizationAccess` to tell a missing organization from a failed lookup.
   */
  async isOrganizationAccessible(organizationKey: string): Promise<boolean> {
    const access = await this.resolveOrganizationAccess(organizationKey);
    return access.status === 'accessible';
  }

  /**
   * Fetch a single organization's full record by key via `/api/organizations/search`'s
   * `organizations` filter param, without listing every org the user is a member of.
   * Used by the `sonar import --org` fast path to resolve `alm.key` and
   * `onlyPrivateProjects.enabled` up front instead of leaving them unresolved.
   *
   * Unlike most lookups in this class, network/API failures are NOT swallowed here: callers
   * rely on `onlyPrivateProjects.enabled` for visibility enforcement, and silently returning
   * `undefined` on a transient failure would silently disable that enforcement instead of
   * surfacing the problem. A `undefined` return only ever means "no org with this key".
   */
  async fetchOrganizationByKey(organizationKey: string): Promise<Organization | undefined> {
    const result = await this.get<{ organizations: Organization[] }>('/api/organizations/search', {
      organizations: organizationKey,
    });
    return result.organizations.find((org) => org.key === organizationKey);
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
   * Create a Vortex analysis (single- or multi-file). On Cloud the endpoint lives on the
   * region-specific API host; on Server the A3S hub serves it from the instance itself.
   */
  async createAnalysis(request: SqaaAnalysisRequest): Promise<SqaaAnalysisResponse> {
    const endpoint = this.isCloud ? '/a3s-analysis/analyses' : '/api/v2/a3s/analyses';
    try {
      return await this.post<SqaaAnalysisResponse>(
        endpoint,
        request,
        resolveFromEndpoint(this.serverURL, endpoint),
        { [SONAR_INVOCATION_ID_HEADER]: INVOCATION_ID },
      );
    } catch (err) {
      // 403 on this endpoint means Agentic Pack entitlement was revoked.
      if (err instanceof ForbiddenApiError) {
        throw new SqaaForbiddenError();
      }
      throw err;
    }
  }
}

/**
 * Vortex is one product: if either hub is missing or unlicensed, neither capability
 * loads. Priority among remaining outcomes: `check_failed > not_entitled >
 * over_consumption > enabled`.
 *
 * Only the CAG hub's `consumption` is surfaced today (A3S is licensed instance-wide and
 * reports no quota), and only for `enabled`: once over the limit the remaining headroom
 * is no longer meaningful.
 */
function mergeVortexEntitlement(
  sqaa: VortexEntitlementResult,
  cag: VortexEntitlementResult,
): VortexEntitlementResult {
  if (sqaa.status === 'not_applicable' || cag.status === 'not_applicable') {
    return { status: 'not_applicable' };
  }
  if (sqaa.status === 'check_failed' || cag.status === 'check_failed') {
    return { status: 'check_failed' };
  }
  if (sqaa.status === 'not_entitled' || cag.status === 'not_entitled') {
    return { status: 'not_entitled' };
  }
  if (sqaa.status === 'over_consumption' || cag.status === 'over_consumption') {
    return { status: 'over_consumption' };
  }
  return { status: 'enabled', consumption: cag.consumption };
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

interface StructuredErrorBody {
  message?: string;
  code?: string;
  meta?: RequestPayloadTooLargeMeta | Record<string, unknown>;
}

async function readStructuredErrorBody(response: Response): Promise<{
  body?: StructuredErrorBody;
  text: string;
}> {
  const text = await response.text();
  try {
    return { body: JSON.parse(text) as StructuredErrorBody, text };
  } catch {
    return { text };
  }
}

function badRequestFallbackMessage(response: Response, text: string): string {
  const detail = text ? ' - ' + text : '';
  return `SonarQube API error: ${response.status} ${response.statusText}${detail}`;
}

async function parseBadRequestError(response: Response): Promise<BadRequestError> {
  const { body, text } = await readStructuredErrorBody(response);
  const fallback = badRequestFallbackMessage(response, text);
  if (!body) {
    return new BadRequestError(fallback);
  }
  return new BadRequestError(
    body.message ?? fallback,
    body.code,
    body.meta as Record<string, unknown> | undefined,
  );
}

async function parseRequestPayloadTooLargeError(
  response: Response,
): Promise<RequestPayloadTooLargeError> {
  const { body, text } = await readStructuredErrorBody(response);
  const fallback = badRequestFallbackMessage(response, text);
  if (!body) {
    return new RequestPayloadTooLargeError(fallback);
  }
  const message = body.message ?? fallback;
  const code =
    body.code === 'REQUEST_TOO_LARGE' || body.code === 'TOO_MANY_FILES' ? body.code : undefined;
  const meta = body.meta;
  return new RequestPayloadTooLargeError(message, code, meta);
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
  /** Cloud-only: the Server hub forces the request onto the instance's default organization. */
  organizationKey?: string;
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

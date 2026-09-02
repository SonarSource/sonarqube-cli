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

// Lightweight in-process mock SonarQube HTTP server (Bun.serve)

import type { Organization } from '@/core/server/client.ts';
import type { SettingsValue } from '@/core/server/settings-value.ts';
import type {
  Metric,
  QualityGateCondition,
  QualityGateStatus,
  SonarQubeIssue,
} from '@/core/server/types.ts';

import type { RecordedRequest } from './types.js';

const HTTP_BAD_REQUEST = 400;

export interface IssueConfig {
  key?: string;
  ruleKey: string;
  message: string;
  severity?: 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL' | 'BLOCKER';
  component?: string;
  status?: string;
  type?: string;
  line?: number;
  fixableByAgent?: boolean;
}

export interface SqaaIssueConfig {
  rule: string;
  message: string;
  startLine?: number;
}

export interface SqaaResponseConfig {
  issues?: SqaaIssueConfig[];
  errors?: Array<{ code: string; message: string }>;
}

interface ProjectData {
  key: string;
  name: string;
  issues: Required<IssueConfig>[];
  qualityGateStatus?: QualityGateStatus;
  qualityGateConditions?: QualityGateCondition[];
  defaultBranchName: string | null;
  unanalyzedBranch?: string;
}

export interface DopRepositoryConfig {
  id: string;
  name: string;
  slug: string;
  private?: boolean;
  archived?: boolean;
  boundProjectIds?: string[];
  importedInCurrentOrg?: boolean;
}

export class ProjectBuilder {
  private readonly projectKey: string;
  private readonly issues: Required<IssueConfig>[] = [];
  private qualityGateStatus?: QualityGateStatus;
  private qualityGateConditions?: QualityGateCondition[];
  private defaultBranchName: string | null = 'main';
  private unanalyzedBranch?: string;

  constructor(projectKey: string) {
    this.projectKey = projectKey;
  }

  withIssue(issue: Partial<IssueConfig>): this {
    this.issues.push({
      key: issue.key ?? `ISSUE-${this.issues.length + 1}`,
      ruleKey: issue.ruleKey ?? 'java:S100',
      message: issue.message ?? 'Issue',
      severity: issue.severity ?? 'MAJOR',
      component: issue.component ?? this.projectKey,
      status: issue.status ?? 'OPEN',
      type: issue.type ?? 'CODE_SMELL',
      line: issue.line ?? 1,
      fixableByAgent: issue.fixableByAgent ?? false,
    });
    return this;
  }

  /**
   * Configure `GET /api/qualitygates/project_status`'s verdict for this project. A project
   * with no configured status defaults to `NONE` at response time, matching the real API's
   * "analyzed project, no quality gate" behavior.
   */
  withProjectStatus(status: QualityGateStatus): this {
    this.qualityGateStatus = status;
    return this;
  }

  /** Configure the `conditions` array `GET /api/qualitygates/project_status` returns for this project. */
  withConditions(conditions: QualityGateCondition[]): this {
    this.qualityGateConditions = conditions;
    return this;
  }

  /**
   * Name of the branch `GET /api/project_branches/list` flags `isMain: true` for this project.
   * Defaults to `main`, but real servers use whatever name the repo's default branch has
   * (`master`, `trunk`, ...) — override this to prove callers don't assume a fixed name.
   */
  withDefaultBranchName(name: string): this {
    this.defaultBranchName = name;
    return this;
  }

  /** No branch flagged `isMain: true` — `GET /api/project_branches/list` returns an empty array. */
  withNoDefaultBranch(): this {
    this.defaultBranchName = null;
    return this;
  }

  /**
   * Makes `GET /api/qualitygates/project_status` 404 when queried for this exact branch,
   * matching the real API's "no analysis for this branch yet" response — distinct from
   * `NONE`, which means the project *is* analyzed but has no quality gate.
   */
  withUnanalyzedBranch(branch: string): this {
    this.unanalyzedBranch = branch;
    return this;
  }

  getData(): ProjectData {
    return {
      key: this.projectKey,
      name: this.projectKey,
      issues: this.issues,
      qualityGateStatus: this.qualityGateStatus,
      qualityGateConditions: this.qualityGateConditions,
      defaultBranchName: this.defaultBranchName,
      unanalyzedBranch: this.unanalyzedBranch,
    };
  }
}

export class FakeSonarQubeServer {
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly requests: RecordedRequest[];
  private readonly provisionConcurrency: { current: number; peak: number };
  private readonly treatAsCloud: boolean;

  constructor(
    server: ReturnType<typeof Bun.serve>,
    requests: RecordedRequest[],
    provisionConcurrency: { current: number; peak: number },
    treatAsCloud = false,
  ) {
    this.server = server;
    this.requests = requests;
    this.provisionConcurrency = provisionConcurrency;
    this.treatAsCloud = treatAsCloud;
  }

  /** True when the builder opted in via `asSonarCloud()`. */
  impersonatesSonarCloud(): boolean {
    return this.treatAsCloud;
  }

  /** Peak number of concurrent `provision_projects` requests observed in flight. */
  getPeakConcurrentProvisionRequests(): number {
    return this.provisionConcurrency.peak;
  }

  baseUrl(): string {
    // Use `localhost` (not `127.0.0.1`) so CAG's Cloud-API URL transformation
    // (host → `api.<host>`) lands on `api.localhost`, which resolves to a
    // loopback address per RFC 6761 and reaches the same server.
    // `api.127.0.0.1` would not resolve, breaking any test that exercises
    // Cloud-mode CAG.
    return `http://localhost:${this.server.port}`;
  }

  getRecordedRequests(): RecordedRequest[] {
    return [...this.requests];
  }

  async stop(): Promise<void> {
    await this.server.stop(true);
  }
}

export class FakeSonarQubeServerBuilder {
  private readonly projectBuilders: Map<string, ProjectBuilder> = new Map();
  private readonly systemStatus: 'UP' | 'DOWN' = 'UP';
  private treatAsCloud = false;
  private readonly sqaaEntitlementOrgs: Map<
    string,
    { uuid: string; allowed: boolean; hasEntitlement: boolean }
  > = new Map();
  private readonly cagEntitlementOrgs: Map<
    string,
    {
      uuid: string;
      allowed: boolean;
      hasEntitlement: boolean;
      consumption?: { consumed: number; limit: number };
    }
  > = new Map();
  /** Keyed by org UUID (`resourceId`), for `GET /billing/entitlements`. */
  private readonly privateProjectsEntitlements: Map<string, boolean> = new Map();
  private validToken?: string;
  private systemStatusCode = 200;
  private systemVersion = '9.9.0.00001';
  private memberOrganizations: Organization[] = [];
  private memberOrganizationsTotal?: number;
  private visibleOrganizations: Organization[] = [];
  private readonly dopRepositoriesByOrgId: Map<string, DopRepositoryConfig[]> = new Map();
  /** Keyed by org legacy id, for `GET /dop-translation/organization-bindings`. */
  private readonly organizationBindingsByOrgId: Map<string, string> = new Map();
  private revokeTokenStatusCode = 204;
  private revokeTokenResponseBody = '';
  private sqaaResponse?: SqaaResponseConfig;
  private sqaaStatusCode?: number;
  private sqaaStatusBody?: string;
  private sqaaPayloadLimit?: { maxRequestSize?: number; maxFiles?: number };
  private scaEnabled?: boolean;
  private cagEntitlementStatusCode?: number;
  private cagEntitlementStatusBody?: string;
  private sqaaEntitlementStatusCode?: number;
  private sqaaEntitlementStatusBody?: string;
  private readonly projectSettings: Map<string, SettingsValue[]> = new Map();
  private agentJobErrorCode?: number;
  private agentJobErrorMessage?: string;
  private remediationAgentEntitlement = { eligible: true, delegateIssuesEnabled: true };
  private orgsLookupReturnsEmpty = false;
  private orgsLookupErrorCode?: number;
  private organizationsSearchErrorCode?: number;
  private organizationBindingsErrorCode?: number;
  private serverMode: 'MQR' | 'STANDARD' = 'STANDARD';
  private provisionProjectsStatusCode?: number;
  private provisionProjectsStatusBody?: string;
  private provisionProjectsFailingInstallationKey?: string;
  private provisionProjectsDelayMs?: number;
  private autoscanEligibilityStatusCode?: number;
  private autoscanEligibilityStatusBody?: string;
  private dopSettings: Array<{ id: string; key: string; type: string; url: string }> = [];
  private projectBindings: Array<{ projectKey: string; repository: string; dopSettingId: string }> =
    [];
  private hasProvisionProjects = true;
  private boundProjectsStatusCode?: number;
  private analyzedProjectKeys = new Set<string>();

  private metrics: Metric[] = [];

  /** Configure the server-wide metric catalog `GET /api/metrics/search` returns. */
  withMetrics(metrics: Metric[]): this {
    this.metrics = metrics;
    return this;
  }

  withMode(mode: 'MQR' | 'STANDARD'): this {
    this.serverMode = mode;
    return this;
  }

  withProject(key: string, fn?: (p: ProjectBuilder) => void): this {
    const builder = new ProjectBuilder(key);
    if (fn) fn(builder);
    this.projectBuilders.set(key, builder);
    return this;
  }

  withAuthToken(token: string): this {
    this.validToken = token;
    return this;
  }

  withVersion(version: string): this {
    this.systemVersion = version;
    return this;
  }

  withSystemStatusCode(code: number): this {
    this.systemStatusCode = code;
    return this;
  }

  withOrganizations(orgs: Organization[]): this {
    this.memberOrganizations = orgs;
    return this;
  }

  withOrganizationTotal(total: number): this {
    this.memberOrganizationsTotal = total;
    return this;
  }

  /**
   * Seed public organizations: resolvable by key, but not a membership.
   *
   * They answer `/api/organizations/search?organizations=<key>` like the real API, and stay out
   * of `member=true`.
   */
  withVisibleOrganizations(orgs: Organization[]): this {
    this.visibleOrganizations = orgs;
    return this;
  }

  /**
   * Configure `/dop-translation/dop-repositories` for a given organization's legacy
   * ID (the `id` field returned by `/organizations/organizations`, which defaults to
   * the org key itself unless CAG/SQAA entitlement overrides it).
   */
  withDopRepositories(organizationId: string, repos: DopRepositoryConfig[]): this {
    this.dopRepositoriesByOrgId.set(organizationId, repos);
    return this;
  }

  /**
   * Configure `/dop-translation/organization-bindings`, overriding the value otherwise derived
   * from the org's `alm.key`. The CLI only consults this endpoint when the org record has no
   * `alm`, so a test needs both to exercise the fallback.
   */
  withOrganizationBinding(organizationId: string, devOpsPlatform: string): this {
    this.organizationBindingsByOrgId.set(organizationId, devOpsPlatform);
    return this;
  }

  withTokenRevocationFailure(statusCode = 500, responseBody = 'Token revocation failed'): this {
    this.revokeTokenStatusCode = statusCode;
    this.revokeTokenResponseBody = responseBody;
    return this;
  }

  withSqaaResponse(response: SqaaResponseConfig = {}): this {
    this.sqaaResponse = response;
    return this;
  }

  withAgentJobError(statusCode: number, message: string): this {
    this.agentJobErrorCode = statusCode;
    this.agentJobErrorMessage = message;
    return this;
  }

  withOrgEntitlement(eligible: boolean, delegateIssuesEnabled: boolean): this {
    this.remediationAgentEntitlement = { eligible, delegateIssuesEnabled };
    return this;
  }

  /**
   * Make `/organizations/organizations` return an empty array, simulating an
   * `organizationKey` that does not match any visible org.
   */
  withMissingOrg(): this {
    this.orgsLookupReturnsEmpty = true;
    return this;
  }

  /**
   * Make `/organizations/organizations` fail with the given HTTP status code,
   * simulating a network/service error during entitlement pre-flight.
   */
  withOrgsLookupError(statusCode: number): this {
    this.orgsLookupErrorCode = statusCode;
    return this;
  }

  /**
   * Make `/api/organizations/search` fail with the given HTTP status code, simulating a
   * network/service error while resolving a single org by key (the `sonar import --org`
   * fast path) or while listing member orgs (the interactive path).
   */
  withOrganizationBindingsError(statusCode: number): this {
    this.organizationBindingsErrorCode = statusCode;
    return this;
  }

  withOrganizationsSearchError(statusCode: number): this {
    this.organizationsSearchErrorCode = statusCode;
    return this;
  }

  /**
   * Force POST /a3s-analysis/analyses to return a specific HTTP status code.
   * Takes precedence over withSqaaResponse. Useful for testing 429, 503, etc.
   */
  withSqaaStatusCode(status: number, body?: string): this {
    this.sqaaStatusCode = status;
    this.sqaaStatusBody = body;
    return this;
  }

  /**
   * Reject POST /a3s-analysis/analyses with 413 when the raw body or file count
   * exceeds the configured limits. Returns server meta on the error body.
   */
  withSqaaPayloadLimit(limit: { maxRequestSize?: number; maxFiles?: number }): this {
    this.sqaaPayloadLimit = limit;
    return this;
  }

  withSqaaEntitlement(
    orgKey: string,
    uuid: string,
    options: { allowed?: boolean; hasEntitlement?: boolean } = {},
  ): this {
    const allowed = options.allowed ?? true;
    this.sqaaEntitlementOrgs.set(orgKey, {
      uuid,
      allowed,
      // An allowed org is necessarily entitled; default undefined to that.
      hasEntitlement: options.hasEntitlement ?? allowed,
    });
    return this;
  }

  withCagEntitlement(
    orgKey: string,
    uuid: string,
    options: {
      allowed?: boolean;
      hasEntitlement?: boolean;
      consumption?: { consumed: number; limit: number };
    } = {},
  ): this {
    const allowed = options.allowed ?? true;
    this.cagEntitlementOrgs.set(orgKey, {
      uuid,
      allowed,
      hasEntitlement: options.hasEntitlement ?? allowed,
      consumption: options.consumption,
    });
    return this;
  }

  withVortexEntitlement(
    orgKey: string,
    uuid: string,
    options: {
      allowed?: boolean;
      hasEntitlement?: boolean;
      consumption?: { consumed: number; limit: number };
    } = {},
  ): this {
    this.withSqaaEntitlement(orgKey, uuid, options);
    this.withCagEntitlement(orgKey, uuid, options);
    return this;
  }

  /**
   * Make the CLI classify this fake server as SonarQube Cloud, not just route
   * cloud requests to it. Required by anything gated on `isSonarQubeCloud()`
   * (Vortex entitlement, `getServerMode`, `getProjectKeyByGitRemote`): without
   * it those branches silently resolve to the SonarQube Server path, which can
   * produce the expected result for the wrong reason.
   */
  asSonarCloud(): this {
    this.treatAsCloud = true;
    return this;
  }

  /**
   * Force GET /cag/cag-entitlement/{uuid} (and the Server /api/v2 prefix) to
   * return a specific HTTP status code. Useful for testing entitlement check
   * failure paths.
   */
  withCagEntitlementStatusCode(status: number, body?: string): this {
    this.cagEntitlementStatusCode = status;
    this.cagEntitlementStatusBody = body;
    return this;
  }

  /**
   * Force GET /a3s-analysis/org-entitlement/{uuid} (and the Server /api/v2 prefix) to
   * return a specific HTTP status code.
   */
  withSqaaEntitlementStatusCode(status: number, body?: string): this {
    this.sqaaEntitlementStatusCode = status;
    this.sqaaEntitlementStatusBody = body;
    return this;
  }

  /**
   * Configure GET /billing/entitlements?resourceId=<uuid>&resourceType=organization for an
   * org's `uuidV4` (defaults to `<orgKey>-uuid-v4`, matching `/organizations/organizations`'
   * default when no CAG/SQAA entitlement overrides it).
   */
  withPrivateProjectsEntitlement(orgKey: string, allowed: boolean, uuid?: string): this {
    this.privateProjectsEntitlements.set(uuid ?? `${orgKey}-uuid-v4`, allowed);
    return this;
  }

  /**
   * Force POST /api/alm_integration/provision_projects to fail with the given HTTP status
   * code, simulating a provisioning error (e.g. repo already imported, permission denied).
   * When `onlyForInstallationKey` is set, only requests for that exact `installationKeys`
   * value fail — every other request succeeds normally, simulating a mixed-outcome batch.
   */
  withProvisionProjectsError(
    statusCode: number,
    body?: string,
    opts?: { onlyForInstallationKey?: string },
  ): this {
    this.provisionProjectsStatusCode = statusCode;
    this.provisionProjectsStatusBody = body;
    this.provisionProjectsFailingInstallationKey = opts?.onlyForInstallationKey;
    return this;
  }

  /**
   * Add an artificial delay (ms) before responding to POST
   * /api/alm_integration/provision_projects, so tests can observe genuinely concurrent
   * in-flight requests via `getPeakConcurrentProvisionRequests()`.
   */
  withProvisionProjectsDelay(ms: number): this {
    this.provisionProjectsDelayMs = ms;
    return this;
  }

  /**
   * Force GET /api/autoscan/eligibility to fail with the given HTTP status code, so tests can
   * verify a failure here never fails the enclosing `sonar import` run.
   */
  withAutoscanEligibilityError(statusCode: number, body?: string): this {
    this.autoscanEligibilityStatusCode = statusCode;
    this.autoscanEligibilityStatusBody = body;
    return this;
  }

  /**
   * Configure the response of the SCA availability endpoints
   * (`/sca/feature-enabled` for cloud, `/api/v2/sca/feature-enabled` for on-premise).
   * When unset (default), both endpoints return 404 to simulate a server
   * without Sonar Advanced Security installed.
   */
  withScaEnabled(enabled: boolean): this {
    this.scaEnabled = enabled;
    return this;
  }

  /**
   * Configure the response of `/api/settings/values?component=<componentKey>`.
   * Settings shape matches the real API: each entry has at least a `key`, plus
   * optionally `value`, `values`, `fieldValues`, and `inherited`.
   */
  withProjectSettings(componentKey: string, settings: SettingsValue[]): this {
    this.projectSettings.set(componentKey, settings);
    return this;
  }

  withDopSettings(settings: Array<{ id: string; key: string; type: string; url: string }>): this {
    this.dopSettings = settings;
    return this;
  }

  withProjectBindings(
    bindings: Array<{ projectKey: string; repository: string; dopSettingId: string }>,
  ): this {
    this.projectBindings = bindings;
    return this;
  }

  withProvisionProjectsPermission(has: boolean): this {
    this.hasProvisionProjects = has;
    return this;
  }

  withBoundProjectsError(statusCode: number): this {
    this.boundProjectsStatusCode = statusCode;
    return this;
  }

  withAnalyzedProjects(projectKeys: string[]): this {
    for (const key of projectKeys) {
      this.analyzedProjectKeys.add(key);
    }
    return this;
  }

  start(): Promise<FakeSonarQubeServer> {
    const projects = new Map([...this.projectBuilders.entries()].map(([k, v]) => [k, v.getData()]));
    const {
      validToken,
      systemStatus,
      systemStatusCode,
      systemVersion,
      memberOrganizations,
      memberOrganizationsTotal: rawMemberOrganizationsTotal,
      visibleOrganizations,
      dopRepositoriesByOrgId,
      organizationBindingsByOrgId,
      revokeTokenStatusCode,
      revokeTokenResponseBody,
      sqaaResponse,
      sqaaStatusCode,
      sqaaStatusBody,
      sqaaPayloadLimit,
      sqaaEntitlementOrgs,
      cagEntitlementOrgs,
      privateProjectsEntitlements,
      scaEnabled,
      cagEntitlementStatusCode,
      cagEntitlementStatusBody,
      sqaaEntitlementStatusCode,
      sqaaEntitlementStatusBody,
      projectSettings,
      agentJobErrorCode,
      agentJobErrorMessage,
      serverMode,
      remediationAgentEntitlement,
      orgsLookupReturnsEmpty,
      orgsLookupErrorCode,
      organizationsSearchErrorCode,
      organizationBindingsErrorCode,
      provisionProjectsStatusCode,
      provisionProjectsStatusBody,
      provisionProjectsFailingInstallationKey,
      provisionProjectsDelayMs,
      autoscanEligibilityStatusCode,
      autoscanEligibilityStatusBody,
      metrics,
      dopSettings,
      projectBindings,
      hasProvisionProjects,
      boundProjectsStatusCode,
      analyzedProjectKeys,
    } = this;
    const memberOrganizationsTotal = rawMemberOrganizationsTotal ?? memberOrganizations.length;
    const requests: RecordedRequest[] = [];
    const provisionConcurrency = { current: 0, peak: 0 };

    const server = Bun.serve({
      port: 0,
      // Dual-stack local listener so both `localhost` and `api.localhost`
      // resolve to a reachable loopback address across platforms.
      hostname: '::',
      ipv6Only: false,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const query: Record<string, string> = {};
        url.searchParams.forEach((v, k) => {
          query[k] = v;
        });
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        const body = req.method === 'POST' ? await req.text() : undefined;

        requests.push({
          method: req.method,
          url: req.url,
          path,
          query,
          headers,
          body,
          timestamp: Date.now(),
        });

        // Public endpoints (no auth required)
        if (path === '/api/system/status') {
          return new Response(JSON.stringify({ status: systemStatus, version: systemVersion }), {
            status: systemStatusCode,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // sonar-context-augmentation calls /api/server/version to detect
        // SonarQube Cloud: major == 8, minor == 0, build != 29455 ⇒ Cloud
        // (see sonar_api/urls.rs in the CAG repo). Only return a Cloud-shaped
        // version when the test explicitly opts in by configuring CAG
        // entitlement, so suites that exercise on-premise behaviour (e.g.
        // sonar-secrets auth) keep seeing the standard `systemVersion`.
        if (path === '/api/server/version') {
          const version = cagEntitlementOrgs.size > 0 ? '8.0.0.12345' : systemVersion;
          return new Response(version, { headers: { 'Content-Type': 'text/plain' } });
        }

        const authHeader = req.headers.get('Authorization');
        const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
        const isAuthorized = !validToken || bearerToken === validToken;

        if (path === '/api/authentication/validate' && req.method === 'GET') {
          return new Response(JSON.stringify({ valid: isAuthorized }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (!isAuthorized) {
          return new Response(JSON.stringify({ errors: [{ msg: 'Unauthorized' }] }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (path === '/api/authentication/validate') {
          return new Response(JSON.stringify({ valid: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (path === '/api/v2/clean-code-policy/mode') {
          return new Response(JSON.stringify({ mode: serverMode }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (path === '/api/editions/is_valid_license') {
          return new Response(JSON.stringify({ isValidLicense: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (path === '/api/user_tokens/revoke' && req.method === 'POST') {
          if (revokeTokenStatusCode >= HTTP_BAD_REQUEST) {
            return new Response(revokeTokenResponseBody, { status: revokeTokenStatusCode });
          }

          return new Response(null, { status: revokeTokenStatusCode });
        }

        if (path === '/api/issues/search') {
          // SonarQube Server uses `components`, SonarQube Cloud uses `projects`
          const projectKey = query.components ?? query.projects;
          const projectData = projectKey ? projects.get(projectKey) : undefined;

          const issueStatusFilter = query.issueStatuses ? query.issueStatuses.split(',') : null;
          const severityFilter = query.severities ? query.severities.split(',') : null;

          const fixableByAgentFilter = query.fixableByAgent;

          const issues: SonarQubeIssue[] =
            projectData?.issues
              .filter((issue) => !issueStatusFilter || issueStatusFilter.includes(issue.status))
              .filter((issue) => !severityFilter || severityFilter.includes(issue.severity))
              .filter((issue) => fixableByAgentFilter !== 'true' || issue.fixableByAgent)
              .map((issue) => ({
                key: issue.key,
                rule: issue.ruleKey,
                severity: issue.severity,
                component: issue.component,
                project: projectKey ?? '',
                line: issue.line,
                status: issue.status,
                message: issue.message,
                type: issue.type,
              })) ?? [];

          const pageSize = Number.parseInt(query.ps ?? '500', 10);
          const page = Number.parseInt(query.p ?? '1', 10);
          const start = (page - 1) * pageSize;
          const pagedIssues = issues.slice(start, start + pageSize);

          return new Response(
            JSON.stringify({
              total: issues.length,
              p: page,
              ps: pageSize,
              paging: { pageIndex: page, pageSize, total: issues.length },
              issues: pagedIssues,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/api/qualitygates/project_status') {
          const projectKey = query.projectKey;
          const projectData = projectKey ? projects.get(projectKey) : undefined;
          if (!projectData) {
            return new Response(
              JSON.stringify({ errors: [{ msg: `Component key '${projectKey}' not found` }] }),
              { status: 404, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (projectData.unanalyzedBranch && projectData.unanalyzedBranch === query.branch) {
            return new Response(
              JSON.stringify({ errors: [{ msg: 'Component or ref not found' }] }),
              { status: 404, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response(
            JSON.stringify({
              projectStatus: {
                status: projectData.qualityGateStatus ?? 'NONE',
                conditions: projectData.qualityGateConditions ?? [],
              },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/api/metrics/search') {
          return new Response(JSON.stringify({ metrics, total: metrics.length, p: 1, ps: 500 }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // sonar-context-augmentation calls /api/project_branches/list to
        // confirm the project exists in the org during daemon startup. Return
        // a one-branch payload for registered projects; otherwise CAG aborts
        // with "Project '<key>' not found in organization '<org>'".
        if (path === '/api/project_branches/list') {
          const projectKey = query.project;
          const projectData = projectKey ? projects.get(projectKey) : undefined;
          if (!projectData) {
            return new Response(
              JSON.stringify({ errors: [{ msg: `Project '${projectKey}' not found` }] }),
              { status: 404, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response(
            JSON.stringify({
              branches: projectData.defaultBranchName
                ? [
                    {
                      name: projectData.defaultBranchName,
                      isMain: true,
                      type: 'LONG',
                      status: { qualityGateStatus: 'OK' },
                    },
                  ]
                : [],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/api/components/show') {
          const componentKey = query.component;
          const projectData = componentKey ? projects.get(componentKey) : undefined;

          if (!projectData) {
            return new Response(
              JSON.stringify({ errors: [{ msg: `Component '${componentKey}' not found` }] }),
              { status: 404, headers: { 'Content-Type': 'application/json' } },
            );
          }

          return new Response(
            JSON.stringify({ component: { key: projectData.key, name: projectData.name } }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/api/qualityprofiles/search') {
          return new Response(
            JSON.stringify({ profiles: [{ key: 'default', name: 'Sonar way', language: 'js' }] }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/api/components/search' || path === '/api/projects/search') {
          const allProjects = [...projects.values()].map((p) => ({
            key: p.key,
            name: p.name,
            qualifier: 'TRK',
          }));

          const pageSize = Number.parseInt(query.ps ?? '500', 10);
          const page = Number.parseInt(query.p ?? '1', 10);

          return new Response(
            JSON.stringify({
              paging: { pageIndex: page, pageSize, total: allProjects.length },
              components: allProjects,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/api/organizations/search') {
          if (organizationsSearchErrorCode !== undefined) {
            return new Response(
              JSON.stringify({ errors: [{ msg: 'Organizations search failed' }] }),
              {
                status: organizationsSearchErrorCode,
                headers: { 'Content-Type': 'application/json' },
              },
            );
          }
          // member=true → list orgs the user belongs to
          if (query.member === 'true') {
            return new Response(
              JSON.stringify({
                organizations: memberOrganizations,
                paging: {
                  pageIndex: 1,
                  pageSize: memberOrganizations.length,
                  total: memberOrganizationsTotal,
                },
              }),
              { headers: { 'Content-Type': 'application/json' } },
            );
          }
          // organizations=KEY → resolve a specific org key, membership-independent like the
          // real API, which also resolves public orgs the caller does not belong to.
          if (query.organizations) {
            const match = [...memberOrganizations, ...visibleOrganizations].filter(
              (o) => o.key === query.organizations,
            );
            return new Response(JSON.stringify({ organizations: match }), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ organizations: memberOrganizations }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (path === '/organizations/organizations') {
          if (orgsLookupErrorCode !== undefined) {
            return new Response(JSON.stringify({ errors: [{ msg: 'Org lookup failed' }] }), {
              status: orgsLookupErrorCode,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (orgsLookupReturnsEmpty) {
            return new Response(JSON.stringify([]), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const orgKey = query.organizationKey;
          const sqaaEntitlement = orgKey ? sqaaEntitlementOrgs.get(orgKey) : undefined;
          const cagEntitlement = orgKey ? cagEntitlementOrgs.get(orgKey) : undefined;
          const entitlementUuid = cagEntitlement?.uuid ?? sqaaEntitlement?.uuid;
          if (orgKey && entitlementUuid) {
            return new Response(
              JSON.stringify([
                { id: `id-${orgKey}`, uuidV4: entitlementUuid, key: orgKey, name: orgKey },
              ]),
              { headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (orgKey) {
            // Default: return a valid org so the AI remediation pre-flight passes in tests
            // that don't configure SQAA entitlement. SQAA checks still return false because
            // /a3s-analysis/org-config/{uuid} returns 404 for unconfigured orgs.
            return new Response(
              JSON.stringify([
                { id: orgKey, uuidV4: `${orgKey}-uuid-v4`, key: orgKey, name: orgKey },
              ]),
              { headers: { 'Content-Type': 'application/json' } },
            );
          }
          // No organizationKey query param: sonar-context-augmentation can call
          // /organizations/organizations with no params during entitlement
          // resolution and expects a flat list of accessible orgs.
          // Synthesize entries from the orgs that have CAG/SQAA entitlement
          // registered so the daemon can find a matching org by key.
          const knownOrgs = new Set<string>([
            ...cagEntitlementOrgs.keys(),
            ...sqaaEntitlementOrgs.keys(),
          ]);
          if (knownOrgs.size > 0) {
            return new Response(
              JSON.stringify(
                [...knownOrgs].map((key) => ({
                  id: `id-${key}`,
                  uuidV4:
                    cagEntitlementOrgs.get(key)?.uuid ??
                    sqaaEntitlementOrgs.get(key)?.uuid ??
                    `${key}-uuid-v4`,
                  key,
                  name: key,
                })),
              ),
              { headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response(JSON.stringify([]), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (path === '/enterprises/enterprise-organizations') {
          // Orgs not in an enterprise map to an empty list; identity caches that as null.
          return new Response(JSON.stringify([]), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (path === '/dop-translation/dop-repositories') {
          const organizationId = query.organizationId;
          const allRepos = organizationId ? (dopRepositoriesByOrgId.get(organizationId) ?? []) : [];
          const pageSize = Number.parseInt(query.pageSize ?? '25', 10);
          const pageIndex = Number.parseInt(query.pageIndex ?? '1', 10);
          const start = (pageIndex - 1) * pageSize;
          const pagedRepos = allRepos.slice(start, start + pageSize).map((r) => ({
            id: r.id,
            name: r.name,
            slug: r.slug,
            private: r.private ?? false,
            archived: r.archived ?? false,
            boundProjectIds: r.boundProjectIds ?? [],
            importedInCurrentOrg: r.importedInCurrentOrg ?? false,
          }));

          return new Response(
            JSON.stringify({
              repositories: pagedRepos,
              page: { pageIndex, pageSize, total: allRepos.length },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/dop-translation/organization-bindings') {
          if (organizationBindingsErrorCode !== undefined) {
            return new Response(
              JSON.stringify({ errors: [{ msg: 'Organization bindings lookup failed' }] }),
              {
                status: organizationBindingsErrorCode,
                headers: { 'Content-Type': 'application/json' },
              },
            );
          }
          // `organizationId` here is the org's legacy id, which `/organizations/organizations`
          // defaults to the org key itself in this fake server (see above), so matching on
          // `key` mirrors real lookup-by-legacy-id behavior for these tests.
          const org = memberOrganizations.find((o) => o.key === query.organizationId);
          const devOpsPlatform =
            organizationBindingsByOrgId.get(query.organizationId ?? '') ?? org?.alm?.key;
          const organizationBindings = devOpsPlatform ? [{ devOpsPlatform }] : [];
          return new Response(
            JSON.stringify({
              organizationBindings,
              page: { pageIndex: 1, pageSize: 50, total: organizationBindings.length },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/billing/entitlements' && req.method === 'GET') {
          const allowed = privateProjectsEntitlements.get(query.resourceId ?? '') ?? false;
          return new Response(
            JSON.stringify({
              entitlements: allowed ? [{ allowedFeatures: ['privateProjects'] }] : [],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/api/alm_integration/provision_projects' && req.method === 'POST') {
          provisionConcurrency.current++;
          provisionConcurrency.peak = Math.max(
            provisionConcurrency.peak,
            provisionConcurrency.current,
          );
          try {
            if (provisionProjectsDelayMs) {
              await new Promise((resolve) => setTimeout(resolve, provisionProjectsDelayMs));
            }

            const params = new URLSearchParams(body ?? '');
            const installationKeys = params.get('installationKeys') ?? '';
            const shouldFail =
              provisionProjectsStatusCode !== undefined &&
              (provisionProjectsFailingInstallationKey === undefined ||
                provisionProjectsFailingInstallationKey === installationKeys);

            if (shouldFail) {
              return new Response(
                provisionProjectsStatusBody ??
                  JSON.stringify({ errors: [{ msg: 'Provisioning failed' }] }),
                {
                  status: provisionProjectsStatusCode,
                  headers: { 'Content-Type': 'application/json' },
                },
              );
            }

            const organization = params.get('organization') ?? '';
            const projectKey = `${organization}_${installationKeys}`.replace(
              /[^a-zA-Z0-9_-]/g,
              '_',
            );
            return new Response(JSON.stringify({ projects: [{ projectKey }] }), {
              headers: { 'Content-Type': 'application/json' },
            });
          } finally {
            provisionConcurrency.current--;
          }
        }

        if (path === '/api/autoscan/eligibility' && req.method === 'GET') {
          if (autoscanEligibilityStatusCode !== undefined) {
            return new Response(
              autoscanEligibilityStatusBody ??
                JSON.stringify({ errors: [{ msg: 'Autoscan eligibility failed' }] }),
              {
                status: autoscanEligibilityStatusCode,
                headers: { 'Content-Type': 'application/json' },
              },
            );
          }
          return new Response(JSON.stringify({ eligible: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (path === '/api/settings/values' && req.method === 'GET') {
          const component = query.component;
          if (component && !projects.has(component)) {
            return new Response(
              JSON.stringify({ errors: [{ msg: `Component '${component}' not found` }] }),
              { status: 404, headers: { 'Content-Type': 'application/json' } },
            );
          }
          const settings = component ? (projectSettings.get(component) ?? []) : [];
          return new Response(JSON.stringify({ settings }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (path === '/sca/feature-enabled' || path === '/api/v2/sca/feature-enabled') {
          if (scaEnabled === undefined) {
            return new Response(JSON.stringify({ errors: [{ msg: 'Not found' }] }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ enabled: scaEnabled }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const orgEntitlementMatch =
          /^(?:\/api\/v2)?\/a3s(?:-analysis)?\/org-entitlement\/(.+)$/.exec(path);
        if (orgEntitlementMatch) {
          if (sqaaEntitlementStatusCode !== undefined) {
            return new Response(
              sqaaEntitlementStatusBody ?? JSON.stringify({ errors: [{ msg: 'SQAA failed' }] }),
              {
                status: sqaaEntitlementStatusCode,
                headers: { 'Content-Type': 'application/json' },
              },
            );
          }
          const uuid = orgEntitlementMatch[1];
          const entitlement = [...sqaaEntitlementOrgs.values()].find((e) => e.uuid === uuid);
          if (!entitlement) {
            return new Response(JSON.stringify({ errors: [{ msg: 'Not found' }] }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(
            JSON.stringify({
              id: uuid,
              allowed: entitlement.allowed,
              hasEntitlement: entitlement.hasEntitlement,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        const cagEntitlementMatch = /^(?:\/api\/v2)?\/cag\/cag-entitlement\/(.+)$/.exec(path);
        if (cagEntitlementMatch) {
          if (cagEntitlementStatusCode !== undefined) {
            return new Response(
              cagEntitlementStatusBody ?? JSON.stringify({ errors: [{ msg: 'CAG failed' }] }),
              {
                status: cagEntitlementStatusCode,
                headers: { 'Content-Type': 'application/json' },
              },
            );
          }
          const uuid = cagEntitlementMatch[1];
          const entitlement = [...cagEntitlementOrgs.values()].find((e) => e.uuid === uuid);
          if (!entitlement) {
            return new Response(JSON.stringify({ errors: [{ msg: 'Not found' }] }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(
            JSON.stringify({
              allowed: entitlement.allowed,
              hasEntitlement: entitlement.hasEntitlement,
              ...(entitlement.consumption ? { consumption: entitlement.consumption } : {}),
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/api/navigation/component') {
          const componentKey = query.component;
          const projectData = componentKey ? projects.get(componentKey) : undefined;
          if (!projectData) {
            return new Response(
              JSON.stringify({ errors: [{ msg: `Component '${componentKey}' not found` }] }),
              { status: 404, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response(
            JSON.stringify({
              id: `AY${componentKey}legacy`,
              key: projectData.key,
              name: projectData.name,
              qualifier: 'TRK',
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/fix-suggestions/ai-agent-scheduled-jobs' && req.method === 'POST') {
          if (agentJobErrorCode !== undefined) {
            return new Response(JSON.stringify({ message: agentJobErrorMessage }), {
              status: agentJobErrorCode,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ taskId: 'task-abc-123' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (
          (path === '/a3s-analysis/analyses' || path === '/api/v2/a3s/analyses') &&
          req.method === 'POST'
        ) {
          if (sqaaStatusCode !== undefined) {
            return new Response(JSON.stringify({ message: sqaaStatusBody ?? 'simulated error' }), {
              status: sqaaStatusCode,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          if (!sqaaResponse) {
            return new Response(
              JSON.stringify({ errors: [{ msg: 'SQAA endpoint not configured' }] }),
              { status: 404, headers: { 'Content-Type': 'application/json' } },
            );
          }

          let requestBody: { files?: unknown } = {};
          try {
            requestBody = JSON.parse(body ?? '{}') as { files?: unknown };
          } catch {
            return new Response(JSON.stringify({ message: 'Invalid JSON body' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          if (!Array.isArray(requestBody.files) || requestBody.files.length === 0) {
            return new Response(JSON.stringify({ message: 'files[] is required' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          const files = requestBody.files as Array<{ path: string; content: string }>;

          if (sqaaPayloadLimit) {
            const bodyBytes = Buffer.byteLength(body ?? '', 'utf8');
            const tooMany =
              sqaaPayloadLimit.maxFiles != null && files.length > sqaaPayloadLimit.maxFiles;
            const tooLarge =
              sqaaPayloadLimit.maxRequestSize != null &&
              bodyBytes > sqaaPayloadLimit.maxRequestSize;
            if (tooMany || tooLarge) {
              return new Response(
                JSON.stringify({
                  message: tooMany ? 'Too many files in request' : 'Request payload too large',
                  code: tooMany ? 'TOO_MANY_FILES' : 'REQUEST_TOO_LARGE',
                  meta: {
                    maxRequestSize: sqaaPayloadLimit.maxRequestSize,
                    maxFiles: sqaaPayloadLimit.maxFiles,
                  },
                }),
                { status: 413, headers: { 'Content-Type': 'application/json' } },
              );
            }
          }

          let issueFileIndex = 0;
          const issues = (sqaaResponse.issues ?? []).map((i) => ({
            rule: i.rule,
            message: i.message,
            filePath: files[issueFileIndex++ % files.length]?.path,
            textRange: i.startLine
              ? { startLine: i.startLine, endLine: i.startLine, startOffset: 0, endOffset: 0 }
              : null,
          }));

          return new Response(
            JSON.stringify({
              id: `sqaa-analysis-${Date.now()}`,
              issues,
              errors: sqaaResponse.errors ?? null,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path.startsWith('/fix-suggestions/organization-configs/')) {
          return new Response(
            JSON.stringify({
              codeReviewAgent: {
                organizationEligible: remediationAgentEntitlement.eligible,
                delegateIssuesEnabled: remediationAgentEntitlement.delegateIssuesEnabled,
              },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/api/users/current') {
          const global = hasProvisionProjects ? ['provisioning'] : [];
          return new Response(
            JSON.stringify({ id: 'fake-user-uuid', login: 'fake-user', permissions: { global } }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/api/v2/dop-translation/dop-settings') {
          return new Response(JSON.stringify({ dopSettings }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (path === '/api/v2/dop-translation/project-bindings' && req.method === 'GET') {
          const { dopSettingId, pageSize: pageSizeStr, pageIndex: pageIndexStr } = query;
          const pageSize = Number.parseInt(pageSizeStr ?? '500', 10);
          const pageIndex = Number.parseInt(pageIndexStr ?? '1', 10);
          const filtered = dopSettingId
            ? projectBindings.filter((b) => b.dopSettingId === dopSettingId)
            : projectBindings;
          const start = (pageIndex - 1) * pageSize;
          const page = filtered.slice(start, start + pageSize);
          return new Response(
            JSON.stringify({
              projectBindings: page.map(({ projectKey, repository }) => ({
                projectKey,
                repository,
              })),
              page: { total: filtered.length, pageSize, pageIndex },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/api/project_analyses/search' && req.method === 'GET') {
          const projectKey = query.project ?? '';
          const hasAnalysis = analyzedProjectKeys.has(projectKey);
          const analyses = hasAnalysis ? [{ key: 'AX1', date: '2024-01-01T00:00:00+0000' }] : [];
          return new Response(
            JSON.stringify({
              paging: { pageIndex: 1, pageSize: 1, total: analyses.length },
              analyses,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        if (path === '/api/v2/dop-translation/bound-projects' && req.method === 'POST') {
          if (boundProjectsStatusCode !== undefined) {
            return new Response(JSON.stringify({ errors: [{ msg: 'Bound project error' }] }), {
              status: boundProjectsStatusCode,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const payload = JSON.parse(body ?? '{}') as {
            projectKey: string;
            repositoryIdentifier: string;
            devOpsPlatformSettingId: string;
          };
          projectBindings.push({
            projectKey: payload.projectKey,
            repository: payload.repositoryIdentifier,
            dopSettingId: payload.devOpsPlatformSettingId,
          });
          return new Response(JSON.stringify({}), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ errors: [{ msg: `Unknown endpoint: ${path}` }] }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    return Promise.resolve(
      new FakeSonarQubeServer(server, requests, provisionConcurrency, this.treatAsCloud),
    );
  }
}

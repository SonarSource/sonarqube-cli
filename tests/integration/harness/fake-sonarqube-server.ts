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

import type { SonarQubeIssue } from '../../../src/lib/types.js';
import type { SettingsValue } from '../../../src/sonarqube/settings-value.js';
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
}

export class ProjectBuilder {
  private readonly projectKey: string;
  private readonly issues: Required<IssueConfig>[] = [];

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

  getData(): ProjectData {
    return {
      key: this.projectKey,
      name: this.projectKey,
      issues: this.issues,
    };
  }
}

export class FakeSonarQubeServer {
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly requests: RecordedRequest[];

  constructor(server: ReturnType<typeof Bun.serve>, requests: RecordedRequest[]) {
    this.server = server;
    this.requests = requests;
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.server.port}`;
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
  private readonly sqaaEntitlementOrgs: Map<
    string,
    { uuid: string; eligible: boolean; enabled: boolean }
  > = new Map();
  private readonly cagEntitlementOrgs: Map<string, { eligible: boolean; enabled: boolean }> =
    new Map();
  private validToken?: string;
  private systemStatusCode = 200;
  private systemVersion = '9.9.0.00001';
  private memberOrganizations: Array<{ key: string; name: string }> = [];
  private memberOrganizationsTotal?: number;
  private revokeTokenStatusCode = 204;
  private revokeTokenResponseBody = '';
  private sqaaResponse?: SqaaResponseConfig;
  private sqaaStatusCode?: number;
  private sqaaStatusBody?: string;
  private scaEnabled?: boolean;
  private readonly projectSettings: Map<string, SettingsValue[]> = new Map();
  private agentJobErrorCode?: number;
  private agentJobErrorMessage?: string;
  private remediationAgentEntitlement = { eligible: true, delegateIssuesEnabled: true };
  private orgsLookupReturnsEmpty = false;
  private orgsLookupErrorCode?: number;

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

  withOrganizations(orgs: Array<{ key: string; name: string }>): this {
    this.memberOrganizations = orgs;
    return this;
  }

  withOrganizationTotal(total: number): this {
    this.memberOrganizationsTotal = total;
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
   * Force POST /a3s-analysis/analyses to return a specific HTTP status code.
   * Takes precedence over withSqaaResponse. Useful for testing 429, 503, etc.
   */
  withSqaaStatusCode(status: number, body?: string): this {
    this.sqaaStatusCode = status;
    this.sqaaStatusBody = body;
    return this;
  }

  withSqaaEntitlement(
    orgKey: string,
    uuid: string,
    options: { eligible?: boolean; enabled?: boolean } = {},
  ): this {
    this.sqaaEntitlementOrgs.set(orgKey, {
      uuid,
      eligible: options.eligible ?? true,
      enabled: options.enabled ?? true,
    });
    return this;
  }

  withCagEntitlement(
    orgKey: string,
    options: { eligible?: boolean; enabled?: boolean } = {},
  ): this {
    this.cagEntitlementOrgs.set(orgKey, {
      eligible: options.eligible ?? true,
      enabled: options.enabled ?? true,
    });
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

  start(): Promise<FakeSonarQubeServer> {
    const projects = new Map([...this.projectBuilders.entries()].map(([k, v]) => [k, v.getData()]));
    const {
      validToken,
      systemStatus,
      systemStatusCode,
      systemVersion,
      memberOrganizations,
      memberOrganizationsTotal: rawMemberOrganizationsTotal,
      revokeTokenStatusCode,
      revokeTokenResponseBody,
      sqaaResponse,
      sqaaStatusCode,
      sqaaStatusBody,
      sqaaEntitlementOrgs,
      cagEntitlementOrgs,
      scaEnabled,
      projectSettings,
      agentJobErrorCode,
      agentJobErrorMessage,
      remediationAgentEntitlement,
      orgsLookupReturnsEmpty,
      orgsLookupErrorCode,
    } = this;
    const memberOrganizationsTotal = rawMemberOrganizationsTotal ?? memberOrganizations.length;
    const requests: RecordedRequest[] = [];

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
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
          // organizations=KEY → validate a specific org key
          if (query.organizations) {
            const match = memberOrganizations.filter((o) => o.key === query.organizations);
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
          const entitlement = orgKey ? sqaaEntitlementOrgs.get(orgKey) : undefined;
          if (entitlement) {
            return new Response(
              JSON.stringify([
                { id: `id-${orgKey}`, uuidV4: entitlement.uuid, key: orgKey, name: orgKey },
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
          return new Response(JSON.stringify([]), {
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

        const orgConfigMatch = /^\/a3s-analysis\/org-config\/(.+)$/.exec(path);
        if (orgConfigMatch) {
          const uuid = orgConfigMatch[1];
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
              eligible: entitlement.eligible,
              enabled: entitlement.enabled,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        }

        const cagOrgConfigMatch = /^\/a3s-analysis\/cag-org-config\/(.+)$/.exec(path);
        if (cagOrgConfigMatch) {
          const uuid = cagOrgConfigMatch[1];
          // UUID is derived from org key as `${orgKey}-uuid-v4` (matches the default
          // org UUID fallback in /organizations/organizations).
          const orgKey = [...cagEntitlementOrgs.keys()].find((k) => `${k}-uuid-v4` === uuid);
          const entitlement = orgKey ? cagEntitlementOrgs.get(orgKey) : undefined;
          if (!entitlement) {
            return new Response(JSON.stringify({ errors: [{ msg: 'Not found' }] }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(
            JSON.stringify({
              id: uuid,
              eligible: entitlement.eligible,
              enabled: entitlement.enabled,
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

        if (path === '/a3s-analysis/analyses' && req.method === 'POST') {
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

          const issues = (sqaaResponse.issues ?? []).map((i) => ({
            rule: i.rule,
            message: i.message,
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

        return new Response(JSON.stringify({ errors: [{ msg: `Unknown endpoint: ${path}` }] }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    return Promise.resolve(new FakeSonarQubeServer(server, requests));
  }
}

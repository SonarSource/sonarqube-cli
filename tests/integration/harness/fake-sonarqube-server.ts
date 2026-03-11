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

// Lightweight in-process mock SonarQube HTTP server (Bun.serve)

import type { RecordedRequest } from './types.js';
import type { SonarQubeIssue } from '../../../src/lib/types.js';

export interface IssueConfig {
  key?: string;
  ruleKey: string;
  message: string;
  severity?: 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL' | 'BLOCKER';
  component?: string;
  status?: string;
  type?: string;
  line?: number;
}

export interface A3sIssueConfig {
  rule: string;
  message: string;
  startLine?: number;
}

export interface A3sResponseConfig {
  issues?: A3sIssueConfig[];
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
  private validToken?: string;
  private systemStatus: 'UP' | 'DOWN' = 'UP';
  private memberOrganizations: Array<{ key: string; name: string }> = [];
  private memberOrganizationsTotal?: number;
  private a3sResponse?: A3sResponseConfig;

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

  withOrganizations(orgs: Array<{ key: string; name: string }>): this {
    this.memberOrganizations = orgs;
    return this;
  }

  withOrganizationTotal(total: number): this {
    this.memberOrganizationsTotal = total;
    return this;
  }

  withA3sResponse(response: A3sResponseConfig = {}): this {
    this.a3sResponse = response;
    return this;
  }

  start(): Promise<FakeSonarQubeServer> {
    const projects = new Map([...this.projectBuilders.entries()].map(([k, v]) => [k, v.getData()]));
    const validToken = this.validToken;
    const systemStatus = this.systemStatus;
    const memberOrganizations = this.memberOrganizations;
    const memberOrganizationsTotal =
      this.memberOrganizationsTotal ?? this.memberOrganizations.length;
    const a3sResponse = this.a3sResponse;
    const requests: RecordedRequest[] = [];

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
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

        requests.push({
          method: req.method,
          url: req.url,
          path,
          query,
          headers,
          timestamp: Date.now(),
        });

        const authHeader = req.headers.get('Authorization');
        const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
        const isAuthorized = !validToken || bearerToken === validToken;

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

        if (path === '/api/system/status') {
          return new Response(JSON.stringify({ status: systemStatus, version: '9.9.0.00001' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (path === '/api/issues/search') {
          // SonarQube Server uses `components`, SonarQube Cloud uses `projects`
          const projectKey = query.components ?? query.projects;
          const projectData = projectKey ? projects.get(projectKey) : undefined;

          const issues: SonarQubeIssue[] =
            projectData?.issues.map((issue) => ({
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

          return new Response(
            JSON.stringify({
              total: issues.length,
              p: page,
              ps: pageSize,
              paging: { pageIndex: page, pageSize, total: issues.length },
              issues,
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

        if (path === '/a3s-analysis/analyses' && req.method === 'POST') {
          if (!a3sResponse) {
            return new Response(
              JSON.stringify({ errors: [{ msg: 'A3S endpoint not configured' }] }),
              { status: 404, headers: { 'Content-Type': 'application/json' } },
            );
          }

          const issues = (a3sResponse.issues ?? []).map((i) => ({
            rule: i.rule,
            message: i.message,
            textRange: i.startLine
              ? { startLine: i.startLine, endLine: i.startLine, startOffset: 0, endOffset: 0 }
              : null,
          }));

          return new Response(
            JSON.stringify({
              id: `a3s-analysis-${Date.now()}`,
              issues,
              errors: a3sResponse.errors ?? null,
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

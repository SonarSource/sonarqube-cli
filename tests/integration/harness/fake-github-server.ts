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

import { createHash } from 'node:crypto';

import type {
  GitHubBranch,
  GitHubPullRequest,
  GitHubRepo,
  GitHubTreeEntry,
} from '@/core/github/client.ts';

import type { RecordedRequest } from './types.js';

export interface FakeGitHubRepository {
  name: string;
  defaultBranch?: string;
  files?: Record<string, string>;
}

interface Branch {
  sha: string;
  files: Map<string, string>;
}

interface Repository {
  id: number;
  name: string;
  fullName: string;
  defaultBranch: string;
  branches: Map<string, Branch>;
  pullRequests: GitHubPullRequest[];
}

export class FakeGitHubServer {
  constructor(
    private readonly server: ReturnType<typeof Bun.serve>,
    private readonly requests: RecordedRequest[],
  ) {}

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

export class FakeGitHubServerBuilder {
  private readonly organizations = new Map<string, FakeGitHubRepository[]>();
  private token = 'github-token';
  private pageSize = 100;
  private readOnly = false;

  withOrganization(organization: string, repositories: FakeGitHubRepository[]): this {
    this.organizations.set(organization, repositories);
    return this;
  }

  withToken(token: string): this {
    this.token = token;
    return this;
  }

  withPageSize(pageSize: number): this {
    this.pageSize = pageSize;
    return this;
  }

  withReadOnlyAccess(): this {
    this.readOnly = true;
    return this;
  }

  start(): Promise<FakeGitHubServer> {
    const requests: RecordedRequest[] = [];
    const repositories = new Map<string, Repository>();
    for (const [organization, fixtures] of this.organizations) {
      for (const fixture of fixtures) {
        const defaultBranch = fixture.defaultBranch ?? 'main';
        const fullName = `${organization}/${fixture.name}`;
        repositories.set(fullName, {
          id: repositories.size + 1,
          name: fixture.name,
          fullName,
          defaultBranch,
          branches: new Map([
            [
              defaultBranch,
              { sha: 'a'.repeat(40), files: new Map(Object.entries(fixture.files ?? {})) },
            ],
          ]),
          pullRequests: [],
        });
      }
    }
    const { token, pageSize, readOnly } = this;
    let commitCounter = 0;

    const paginate = (items: unknown[], url: URL): Response => {
      const size = Math.min(Number(url.searchParams.get('per_page') ?? 30), pageSize);
      const page = Number(url.searchParams.get('page') ?? 1);
      const headers: Record<string, string> = {};
      if (page * size < items.length) {
        const next = new URL(url);
        next.searchParams.set('page', String(page + 1));
        headers.link = `<${next.href}>; rel="next"`;
      }
      return Response.json(items.slice((page - 1) * size, page * size), { headers });
    };

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        const body =
          request.method === 'POST' || request.method === 'PUT' ? await request.text() : undefined;
        requests.push({
          method: request.method,
          url: request.url,
          path,
          query: Object.fromEntries(url.searchParams),
          headers: Object.fromEntries(request.headers),
          body,
          timestamp: Date.now(),
        });

        if (request.headers.get('authorization') !== `Bearer ${token}`) {
          return Response.json({ message: 'Bad credentials' }, { status: 401 });
        }
        if (readOnly && request.method !== 'GET') {
          return Response.json(
            { message: 'Resource not accessible by personal access token' },
            {
              status: 403,
              headers: { 'x-accepted-github-permissions': 'contents=write' },
            },
          );
        }

        const organizationMatch = /^\/orgs\/([^/]+)\/repos$/.exec(path);
        if (organizationMatch && request.method === 'GET') {
          const organization = decodeURIComponent(organizationMatch[1]);
          return paginate(
            [...repositories.values()]
              .filter((repo) => repo.fullName.startsWith(`${organization}/`))
              .map(metadata),
            url,
          );
        }

        const repositoryMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
        const fullName = repositoryMatch
          ? `${decodeURIComponent(repositoryMatch[1])}/${decodeURIComponent(repositoryMatch[2])}`
          : '';
        const repo = repositories.get(fullName);
        if (!repo) return Response.json({ message: 'Not Found' }, { status: 404 });
        const endpoint = repositoryMatch?.[3] ?? '';
        if (!endpoint && request.method === 'GET') return Response.json(metadata(repo));

        if (endpoint.startsWith('/git/ref/heads/') && request.method === 'GET') {
          const branchName = decodeURIComponent(endpoint.slice('/git/ref/heads/'.length));
          const branch = repo.branches.get(branchName);
          return branch
            ? Response.json({
                ref: `refs/heads/${branchName}`,
                object: { type: 'commit', sha: branch.sha },
              } satisfies GitHubBranch)
            : Response.json({ message: 'Not Found' }, { status: 404 });
        }

        if (endpoint === '/git/refs' && request.method === 'POST') {
          const payload = JSON.parse(body ?? '{}') as { ref: string; sha: string };
          const name = payload.ref?.slice('refs/heads/'.length);
          const source = [...repo.branches.values()].find((branch) => branch.sha === payload.sha);
          if (
            !payload.ref?.startsWith('refs/heads/') ||
            !name ||
            !source ||
            repo.branches.has(name)
          ) {
            return Response.json(
              { message: 'Invalid reference or reference already exists' },
              { status: 422 },
            );
          }
          repo.branches.set(name, { sha: source.sha, files: new Map(source.files) });
          return Response.json(
            {
              ref: payload.ref,
              object: { type: 'commit', sha: source.sha },
            } satisfies GitHubBranch,
            { status: 201 },
          );
        }

        if (endpoint.startsWith('/git/refs/heads/') && request.method === 'DELETE') {
          const name = decodeURIComponent(endpoint.slice('/git/refs/heads/'.length));
          if (name === repo.defaultBranch || !repo.branches.delete(name)) {
            return Response.json({ message: 'Reference cannot be deleted' }, { status: 422 });
          }
          return new Response(null, { status: 204 });
        }

        if (endpoint.startsWith('/contents/')) {
          const filePath = decodeURIComponent(endpoint.slice('/contents/'.length));
          if (request.method === 'GET') {
            const branch = repo.branches.get(url.searchParams.get('ref') ?? repo.defaultBranch);
            if (!branch) return Response.json({ message: 'Not Found' }, { status: 404 });
            const content = branch.files.get(filePath);
            if (content !== undefined) {
              return Response.json({
                type: 'file',
                path: filePath,
                sha: blobSha(content),
                encoding: 'base64',
                content: Buffer.from(content).toString('base64'),
              });
            }
            const entries = directoryEntries(branch, filePath);
            return entries.length || filePath === ''
              ? Response.json(entries)
              : Response.json({ message: 'Not Found' }, { status: 404 });
          }
          if (request.method === 'PUT') {
            const payload = JSON.parse(body ?? '{}') as {
              branch: string;
              content: string;
              message: string;
            };
            const branch = repo.branches.get(payload.branch);
            if (
              !branch ||
              branch.files.has(filePath) ||
              typeof payload.content !== 'string' ||
              !payload.message
            ) {
              return Response.json(
                { message: 'Invalid file creation or sha was not supplied' },
                { status: 422 },
              );
            }
            branch.files.set(filePath, Buffer.from(payload.content, 'base64').toString('utf8'));
            branch.sha = (++commitCounter).toString(16).padStart(40, '0');
            return Response.json({ commit: { sha: branch.sha } }, { status: 201 });
          }
        }

        if (endpoint === '/pulls') {
          if (request.method === 'GET') {
            const head = url.searchParams.get('head');
            const state = url.searchParams.get('state') ?? 'open';
            const owner = fullName.split('/')[0];
            return paginate(
              repo.pullRequests.filter(
                (pr) =>
                  (state === 'all' || pr.state === state) &&
                  (!head || head === `${owner}:${pr.head.ref}`),
              ),
              url,
            );
          }
          if (request.method === 'POST') {
            const payload = JSON.parse(body ?? '{}') as {
              head: string;
              base: string;
              title: string;
              body: string;
            };
            const head = repo.branches.get(payload.head);
            const base = repo.branches.get(payload.base);
            if (
              !head ||
              !base ||
              head.sha === base.sha ||
              !payload.title ||
              repo.pullRequests.some(
                (pr) => pr.head.ref === payload.head && pr.base.ref === payload.base,
              )
            ) {
              return Response.json(
                { message: 'Invalid or duplicate pull request' },
                { status: 422 },
              );
            }
            const pr: GitHubPullRequest = {
              number: repo.pullRequests.length + 1,
              html_url: `https://github.com/${fullName}/pull/${repo.pullRequests.length + 1}`,
              state: 'open',
              head: { ref: payload.head, sha: head.sha },
              base: { ref: payload.base },
            };
            repo.pullRequests.push(pr);
            return Response.json(pr, { status: 201 });
          }
        }

        return Response.json({ message: 'Not Found' }, { status: 404 });
      },
    });
    return Promise.resolve(new FakeGitHubServer(server, requests));
  }
}

function metadata(repo: Repository): GitHubRepo {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    default_branch: repo.defaultBranch,
    archived: false,
    disabled: false,
  };
}

function blobSha(content: string): string {
  return createHash('sha1')
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest('hex');
}

function directoryEntries(branch: Branch, path: string): GitHubTreeEntry[] {
  const prefix = path ? `${path}/` : '';
  const entries = new Map<string, GitHubTreeEntry>();
  for (const [filePath, content] of branch.files) {
    if (!filePath.startsWith(prefix)) continue;
    const [name, ...rest] = filePath.slice(prefix.length).split('/');
    entries.set(name, {
      name,
      path: `${prefix}${name}`,
      type: rest.length ? 'dir' : 'file',
      sha: rest.length ? branch.sha : blobSha(content),
    });
  }
  return [...entries.values()];
}

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

// Lightweight in-process fake GitLab API server (Bun.serve).
// Implements the subset of the GitLab v4 API used by GitLabClient.

import type { RecordedRequest } from './types.js';

export interface FakeGitLabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  default_branch: string | null;
  /** Root-level files present in the default branch. */
  rootFiles?: Array<{ name: string; content?: string }>;
  /** Whether there is already an open MR from the sonar/add-sonar-analysis-job branch. */
  hasOpenSonarMr?: boolean;
  /** Custom CI config path (GitLab project setting). Omit for default .gitlab-ci.yml. */
  ciConfigPath?: string;
  /** Branches that already exist on the project (e.g. an orphaned CI branch from a prior run). */
  existingBranches?: string[];
}

interface CreatedMr {
  projectId: number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  webUrl: string;
}

interface CommittedFile {
  projectId: number;
  path: string;
  branch: string;
  content: string;
}

export class FakeGitLabServer {
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly requests: RecordedRequest[];
  readonly createdMrs: CreatedMr[];
  readonly committedFiles: CommittedFile[];
  readonly createdBranches: Array<{ projectId: number; branch: string }>;
  readonly deletedBranches: Array<{ projectId: number; branch: string }>;

  constructor(
    server: ReturnType<typeof Bun.serve>,
    requests: RecordedRequest[],
    createdMrs: CreatedMr[],
    committedFiles: CommittedFile[],
    createdBranches: Array<{ projectId: number; branch: string }>,
    deletedBranches: Array<{ projectId: number; branch: string }>,
  ) {
    this.server = server;
    this.requests = requests;
    this.createdMrs = createdMrs;
    this.committedFiles = committedFiles;
    this.createdBranches = createdBranches;
    this.deletedBranches = deletedBranches;
  }

  baseUrl(): string {
    return `http://localhost:${this.server.port}`;
  }

  getRecordedRequests(): RecordedRequest[] {
    return [...this.requests];
  }

  async stop(): Promise<void> {
    await this.server.stop(true);
  }
}

export class FakeGitLabServerBuilder {
  private readonly projects: FakeGitLabProject[] = [];
  private readonly projectsByGroup = new Map<string, FakeGitLabProject[]>();
  private readonly createBranchFailProjectIds = new Set<number>();

  withGroup(groupPath: string, projects: FakeGitLabProject[]): this {
    this.projectsByGroup.set(groupPath, projects);
    for (const p of projects) {
      if (!this.projects.some((existing) => existing.id === p.id)) {
        this.projects.push(p);
      }
    }
    return this;
  }

  /** Makes createBranch return 503 for the given project ID, simulating a GitLab outage. */
  withCreateBranchFailure(projectId: number): this {
    this.createBranchFailProjectIds.add(projectId);
    return this;
  }

  start(): Promise<FakeGitLabServer> {
    const requests: RecordedRequest[] = [];
    const createdMrs: CreatedMr[] = [];
    const committedFiles: CommittedFile[] = [];
    const preExistingBranches: Array<{ projectId: number; branch: string }> = this.projects.flatMap(
      (p) => (p.existingBranches ?? []).map((branch) => ({ projectId: p.id, branch })),
    );
    const createdBranches: Array<{ projectId: number; branch: string }> = [];
    const deletedBranches: Array<{ projectId: number; branch: string }> = [];
    const branchExists = (projectId: number, branch: string): boolean =>
      [...preExistingBranches, ...createdBranches].some(
        (b) => b.projectId === projectId && b.branch === branch,
      );
    const projects = this.projects;
    const projectsByGroup = this.projectsByGroup;
    const createBranchFailProjectIds = this.createBranchFailProjectIds;

    let mrCounter = 1;

    const server = Bun.serve({
      port: 0,
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
        const body = req.method === 'POST' || req.method === 'PUT' ? await req.text() : undefined;

        requests.push({
          method: req.method,
          url: req.url,
          path,
          query,
          headers,
          timestamp: Date.now(),
        });

        const json = (data: unknown, status = 200): Response =>
          new Response(JSON.stringify(data), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });

        // GET /api/v4/projects/{id}
        const projectMatch = /^\/api\/v4\/projects\/(\d+)$/.exec(path);
        if (projectMatch && req.method === 'GET') {
          const projectId = Number.parseInt(projectMatch[1], 10);
          const project = projects.find((p) => p.id === projectId);
          if (!project) return json({ message: 'Not Found' }, 404);
          return json({ id: project.id, ci_config_path: project.ciConfigPath ?? '' });
        }

        // GET /api/v4/groups/{group}/projects
        const groupProjectsMatch = /^\/api\/v4\/groups\/([^/]+)\/projects$/.exec(path);
        if (groupProjectsMatch && req.method === 'GET') {
          const groupPath = decodeURIComponent(groupProjectsMatch[1]);
          const groupProjects = projectsByGroup.get(groupPath) ?? [];
          const pageSize = Number.parseInt(query.per_page ?? '100', 10);
          const page = Number.parseInt(query.page ?? '1', 10);
          const start = (page - 1) * pageSize;
          const paged = groupProjects.slice(start, start + pageSize).map((p) => ({
            id: p.id,
            name: p.name,
            path_with_namespace: p.path_with_namespace,
            default_branch: p.default_branch,
          }));
          return json(paged);
        }

        // GET /api/v4/projects/{id}/repository/tree
        const treeMatch = /^\/api\/v4\/projects\/(\d+)\/repository\/tree$/.exec(path);
        if (treeMatch && req.method === 'GET') {
          const projectId = Number.parseInt(treeMatch[1], 10);
          const project = projects.find((p) => p.id === projectId);
          if (!project) return json({ message: 'Not Found' }, 404);
          const allEntries = (project.rootFiles ?? []).map((f) => ({
            name: f.name,
            type: 'blob',
            path: f.name,
          }));
          const pageSize = Number.parseInt(query.per_page ?? '100', 10);
          const page = Number.parseInt(query.page ?? '1', 10);
          const start = (page - 1) * pageSize;
          return json(allEntries.slice(start, start + pageSize));
        }

        // GET /api/v4/projects/{id}/repository/files/{encoded_path}
        const fileMatch = /^\/api\/v4\/projects\/(\d+)\/repository\/files\/(.+)$/.exec(path);
        if (fileMatch && req.method === 'GET') {
          const projectId = Number.parseInt(fileMatch[1], 10);
          const filePath = decodeURIComponent(fileMatch[2].replace(/%2F/gi, '/'));
          const project = projects.find((p) => p.id === projectId);
          if (!project) return json({ message: 'Not Found' }, 404);
          const rootFile = project.rootFiles?.find((f) => f.name === filePath);
          if (!rootFile) return json({ message: 'Not Found' }, 404);
          const content = Buffer.from(rootFile.content ?? '').toString('base64');
          return json({ content, encoding: 'base64' });
        }

        // POST /api/v4/projects/{id}/repository/branches
        const createBranchMatch = /^\/api\/v4\/projects\/(\d+)\/repository\/branches$/.exec(path);
        if (createBranchMatch && req.method === 'POST') {
          const projectId = Number.parseInt(createBranchMatch[1], 10);
          if (createBranchFailProjectIds.has(projectId)) {
            return json({ message: 'Service Unavailable' }, 503);
          }
          const payload = JSON.parse(body ?? '{}') as { branch: string };
          if (branchExists(projectId, payload.branch)) {
            return json({ message: 'Branch already exists' }, 400);
          }
          createdBranches.push({ projectId, branch: payload.branch });
          return json({ name: payload.branch }, 201);
        }

        // DELETE /api/v4/projects/{id}/repository/branches/{branch}
        const deleteBranchMatch = /^\/api\/v4\/projects\/(\d+)\/repository\/branches\/(.+)$/.exec(
          path,
        );
        if (deleteBranchMatch && req.method === 'DELETE') {
          const projectId = Number.parseInt(deleteBranchMatch[1], 10);
          const branch = decodeURIComponent(deleteBranchMatch[2]);
          deletedBranches.push({ projectId, branch });
          for (const list of [preExistingBranches, createdBranches]) {
            const idx = list.findIndex((b) => b.projectId === projectId && b.branch === branch);
            if (idx >= 0) list.splice(idx, 1);
          }
          return new Response(null, { status: 204 });
        }

        // POST /api/v4/projects/{id}/repository/files/{encoded_path}
        const createFileMatch = /^\/api\/v4\/projects\/(\d+)\/repository\/files\/(.+)$/.exec(path);
        if (createFileMatch && req.method === 'POST') {
          const projectId = Number.parseInt(createFileMatch[1], 10);
          const filePath = decodeURIComponent(createFileMatch[2].replace(/%2F/gi, '/'));
          const payload = JSON.parse(body ?? '{}') as { branch: string; content: string };
          committedFiles.push({
            projectId,
            path: filePath,
            branch: payload.branch,
            content: payload.content,
          });
          return json({ file_path: filePath }, 201);
        }

        // PUT /api/v4/projects/{id}/repository/files/{encoded_path}
        const updateFileMatch = /^\/api\/v4\/projects\/(\d+)\/repository\/files\/(.+)$/.exec(path);
        if (updateFileMatch && req.method === 'PUT') {
          const projectId = Number.parseInt(updateFileMatch[1], 10);
          const filePath = decodeURIComponent(updateFileMatch[2].replace(/%2F/gi, '/'));
          const payload = JSON.parse(body ?? '{}') as { branch: string; content: string };
          committedFiles.push({
            projectId,
            path: filePath,
            branch: payload.branch,
            content: payload.content,
          });
          return json({ file_path: filePath });
        }

        // GET /api/v4/projects/{id}/merge_requests
        const listMrMatch = /^\/api\/v4\/projects\/(\d+)\/merge_requests$/.exec(path);
        if (listMrMatch && req.method === 'GET') {
          const projectId = Number.parseInt(listMrMatch[1], 10);
          const sourceBranch = query.source_branch;
          const project = projects.find((p) => p.id === projectId);
          if (project?.hasOpenSonarMr && sourceBranch === 'sonar/add-sonar-analysis-job') {
            return json([{ iid: 1, web_url: `http://localhost/mr/1`, state: 'opened' }]);
          }
          return json([]);
        }

        // POST /api/v4/projects/{id}/merge_requests
        const createMrMatch = /^\/api\/v4\/projects\/(\d+)\/merge_requests$/.exec(path);
        if (createMrMatch && req.method === 'POST') {
          const projectId = Number.parseInt(createMrMatch[1], 10);
          const payload = JSON.parse(body ?? '{}') as {
            source_branch: string;
            target_branch: string;
            title: string;
            description: string;
          };
          const webUrl = `${url.origin}/mr/${mrCounter++}`;
          createdMrs.push({
            projectId,
            sourceBranch: payload.source_branch,
            targetBranch: payload.target_branch,
            title: payload.title,
            description: payload.description,
            webUrl,
          });
          return json({ web_url: webUrl }, 201);
        }

        return json({ message: `Unknown GitLab endpoint: ${path}` }, 404);
      },
    });

    return Promise.resolve(
      new FakeGitLabServer(
        server,
        requests,
        createdMrs,
        committedFiles,
        createdBranches,
        deletedBranches,
      ),
    );
  }
}

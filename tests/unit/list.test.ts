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

/**
 * Tests for IssuesClient and issuesSearchCommand
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { IssuesClient } from '../../src/sonarqube/issues.js';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import type {
  IssuesSearchResponse,
  ProjectsSearchResponse,
  SonarQubeIssue,
} from '../../src/lib/types.js';
import { listIssues } from '../../src/cli/commands/list/issues';
import { setMockUi } from '../../src/ui';
import { MAX_PAGE_SIZE, ProjectsClient } from '../../src/sonarqube/projects';
import * as authResolver from '../../src/lib/auth-resolver.js';

// Test constants
const DEFAULT_PAGE_SIZE = 500;
const CUSTOM_PAGE_SIZE = 100;

type MockParamValue = string | number | boolean;
type MockParams = Record<string, MockParamValue>;
type MockGetFn = (endpoint: string, params?: MockParams) => Promise<unknown>;

// Helper to create a mock SonarQubeClient
function createMockClient(mockGet: MockGetFn): SonarQubeClient {
  const client = new SonarQubeClient('https://sonarcloud.io', 'test-token');
  client.get = mockGet as SonarQubeClient['get'];
  return client;
}

// Helper to create a mock issue
function createMockIssue(key: string): SonarQubeIssue {
  return {
    key,
    rule: 'typescript:S1234',
    severity: 'MAJOR',
    component: 'my-project:src/file.ts',
    project: 'my-project',
    status: 'OPEN',
    message: 'Test issue',
    type: 'BUG',
  };
}

// Helper to create a mock response
function createMockIssuesResponse(
  issues: SonarQubeIssue[],
  page: number,
  pageSize: number,
  total: number,
): Promise<IssuesSearchResponse> {
  return Promise.resolve({
    total,
    p: page,
    ps: pageSize,
    paging: {
      pageIndex: page,
      pageSize,
      total,
    },
    issues,
  });
}

// Helper to create a mock project component
function createMockProject(key: string, name: string = `Project ${key}`) {
  return { key, name };
}

// Helper to create a mock API response
function createMockProjectsResponse(
  components: { key: string; name: string }[],
  pageIndex: number,
  pageSize: number,
  total: number,
): Promise<ProjectsSearchResponse> {
  return Promise.resolve({
    paging: { pageIndex, pageSize, total },
    components,
  });
}

describe('IssuesClient', () => {
  describe('searchIssues', () => {
    it('should call client.get with correct endpoint', async () => {
      const mockGet = mock((endpoint: string) => {
        expect(endpoint).toBe('/api/issues/search');
        return Promise.resolve(createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });

      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should pass projects parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.projects).toBe('my-project');
        return Promise.resolve(createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });
    });

    it('should pass severities parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.severities).toBe('CRITICAL,BLOCKER');
        return Promise.resolve(createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        severities: 'CRITICAL,BLOCKER',
      });
    });

    it('should pass types parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.types).toBe('BUG,VULNERABILITY');
        return Promise.resolve(createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        types: 'BUG,VULNERABILITY',
      });
    });

    it('should pass statuses parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.statuses).toBe('OPEN,REOPENED');
        return Promise.resolve(createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        statuses: 'OPEN,REOPENED',
      });
    });

    it('should pass resolved=false parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.resolved).toBe(false);
        return Promise.resolve(createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        resolved: false,
      });
    });

    it('should pass resolved=true parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.resolved).toBe(true);
        return Promise.resolve(createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        resolved: true,
      });
    });

    it('should not pass resolved parameter when undefined', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.resolved).toBeUndefined();
        return Promise.resolve(createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });
    });

    it('should pass branch parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.branch).toBe('feature/test');
        return Promise.resolve(createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        branch: 'feature/test',
      });
    });

    it('should pass pullRequest parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.pullRequest).toBe('123');
        return Promise.resolve(createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        pullRequest: '123',
      });
    });

    it('should pass rules parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.rules).toBe('typescript:S1234');
        return Promise.resolve(createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        rules: 'typescript:S1234',
      });
    });

    it('should pass tags parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.tags).toBe('security,performance');
        return Promise.resolve(createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        tags: 'security,performance',
      });
    });

    it('should pass componentKeys parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.componentKeys).toBe('my-project:src/file.ts');
        return Promise.resolve(createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        componentKeys: 'my-project:src/file.ts',
      });
    });

    it('should pass pagination parameters', async () => {
      const pageNum = 2;
      const pageSize = CUSTOM_PAGE_SIZE;
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.p).toBe(pageNum);
        expect(params?.ps).toBe(pageSize);
        return Promise.resolve(createMockIssuesResponse([], pageNum, pageSize, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        p: pageNum,
        ps: pageSize,
      });
    });

    it('should pass sort parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.s).toBe('SEVERITY');
        return Promise.resolve(createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0));
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        s: 'SEVERITY',
      });
    });

    it('should return response with issues', async () => {
      const twoIssues = 2;
      const mockIssues = [createMockIssue('issue-1'), createMockIssue('issue-2')];
      const mockGet = mock(() => {
        return Promise.resolve(
          createMockIssuesResponse(mockIssues, 1, DEFAULT_PAGE_SIZE, twoIssues),
        );
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      const result = await issuesClient.searchIssues({ projects: 'my-project' });

      expect(result.issues).toHaveLength(twoIssues);
      expect(result.issues[0].key).toBe('issue-1');
      expect(result.issues[1].key).toBe('issue-2');
      expect(result.total).toBe(twoIssues);
    });
  });
});

describe('issuesSearchCommand', () => {
  let resolveAuthSpy: ReturnType<typeof spyOn>;

  const mockAuth = {
    token: 'test-token',
    serverUrl: 'https://sonarcloud.io',
    orgKey: 'test-org',
  };

  const emptyApiResponse = {
    issues: [],
    total: 0,
    p: 1,
    ps: 500,
    paging: { pageIndex: 1, pageSize: 500, total: 0 },
  };

  beforeEach(() => {
    setMockUi(true);
    resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue(mockAuth);
  });

  afterEach(() => {
    setMockUi(false);
    resolveAuthSpy.mockRestore();
  });

  it('calls resolveAuth', async () => {
    const getSpy = spyOn(SonarQubeClient.prototype, 'get').mockResolvedValue(emptyApiResponse);

    try {
      await listIssues({ project: 'my-project', page: 1, pageSize: 500 });
      expect(resolveAuthSpy).toHaveBeenCalledWith({ org: undefined });
    } finally {
      getSpy.mockRestore();
    }
  });

  it('passes --org to resolveAuth', async () => {
    const getSpy = spyOn(SonarQubeClient.prototype, 'get').mockResolvedValue(emptyApiResponse);

    try {
      await listIssues({ project: 'my-project', org: 'my-org', page: 1, pageSize: 500 });
      expect(resolveAuthSpy).toHaveBeenCalledWith({ org: 'my-org' });
    } finally {
      getSpy.mockRestore();
    }
  });

  it('propagates auth errors', () => {
    resolveAuthSpy.mockRejectedValue(new Error('Not authenticated. Run: sonar auth login'));

    expect(listIssues({ project: 'proj', page: 1, pageSize: 500 })).rejects.toThrow(
      'sonar auth login',
    );
  });

  it('throws when --project is missing', () => {
    expect(listIssues({ page: 1, pageSize: 500 })).rejects.toThrow('--project is required');
  });

  it('throws when --format is invalid', () => {
    expect(listIssues({ project: 'proj', format: 'xml', page: 1, pageSize: 500 })).rejects.toThrow(
      'xml',
    );
  });

  it('throws when --page is 0', () => {
    expect(listIssues({ project: 'proj', page: 0, pageSize: 500 })).rejects.toThrow('page');
  });

  it('throws when --page-size is 0', () => {
    expect(listIssues({ project: 'proj', page: 1, pageSize: 0 })).rejects.toThrow('page-size');
  });

  it('throws when --page-size exceeds maximum', () => {
    expect(listIssues({ project: 'proj', page: 1, pageSize: MAX_PAGE_SIZE + 1 })).rejects.toThrow(
      'page-size',
    );
  });

  it('throws when --severity is invalid', () => {
    expect(
      listIssues({ project: 'proj', severity: 'EXTREME', page: 1, pageSize: 500 }),
    ).rejects.toThrow('EXTREME');
  });

  it('normalizes severity to uppercase before passing to API', async () => {
    let capturedSeverities: string | undefined;
    const getSpy = spyOn(SonarQubeClient.prototype, 'get').mockImplementation(
      <T>(_endpoint: string, params?: Record<string, string | number | boolean>) => {
        capturedSeverities = (params as Record<string, string>)?.severities;
        return Promise.resolve(emptyApiResponse as unknown as T);
      },
    );

    try {
      await listIssues({ project: 'my-project', severity: 'major', page: 1, pageSize: 500 });
      expect(capturedSeverities).toBe('MAJOR');
    } finally {
      getSpy.mockRestore();
    }
  });

  it('succeeds when issues search returns results', async () => {
    const getSpy = spyOn(SonarQubeClient.prototype, 'get').mockResolvedValue(emptyApiResponse);

    try {
      await listIssues({ project: 'my-project', page: 1, pageSize: 500 });
    } finally {
      getSpy.mockRestore();
    }
  });
});

describe('ProjectsClient', () => {
  describe('searchProjects', () => {
    it('should call client.get with correct endpoint', async () => {
      const mockGet = mock((endpoint: string) => {
        expect(endpoint).toBe('/api/components/search');
        return createMockProjectsResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({});

      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should send qualifiers=TRK when no organization is provided', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.qualifiers).toBe('TRK');
        expect(params.organization).toBeUndefined();
        return createMockProjectsResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({});
    });

    it('should send qualifiers=TRK when organization is undefined', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.qualifiers).toBe('TRK');
        expect(params.organization).toBeUndefined();
        return createMockProjectsResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({ organization: undefined });
    });

    it('should send organization param and omit qualifiers for SonarCloud', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.organization).toBe('my-org');
        expect(params.qualifiers).toBeUndefined();
        return createMockProjectsResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({ organization: 'my-org' });
    });

    it('should pass search query parameter', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.q).toBe('my-project');
        return createMockProjectsResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({ q: 'my-project' });
    });

    it('should not send query param when not specified', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.q).toBeUndefined();
        return createMockProjectsResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({});
    });

    it('should pass page number', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.p).toBe(3);
        return createMockProjectsResponse([], 3, 500, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({ p: 3 });
    });

    it('should pass page size', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.ps).toBe(50);
        return createMockProjectsResponse([], 1, 50, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({ ps: 50 });
    });

    it('should not send page params when not specified', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.p).toBeUndefined();
        expect(params.ps).toBeUndefined();
        return createMockProjectsResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({});
    });

    it('should return response with projects', async () => {
      const mockProjects = [
        createMockProject('proj-1', 'Project One'),
        createMockProject('proj-2', 'Project Two'),
      ];
      const mockGet = mock(() => createMockProjectsResponse(mockProjects, 1, 500, 2));

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      const result = await projectsClient.searchProjects({});

      expect(result.components).toHaveLength(2);
      expect(result.components[0].key).toBe('proj-1');
      expect(result.components[0].name).toBe('Project One');
      expect(result.components[1].key).toBe('proj-2');
      expect(result.components[1].name).toBe('Project Two');
    });

    it('should return paging metadata', async () => {
      const mockGet = mock(() => createMockProjectsResponse([], 2, 50, 200));

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      const result = await projectsClient.searchProjects({ p: 2, ps: 50 });

      expect(result.paging.pageIndex).toBe(2);
      expect(result.paging.pageSize).toBe(50);
      expect(result.paging.total).toBe(200);
    });

    it('should return empty list when no projects found', async () => {
      const mockGet = mock(() => createMockProjectsResponse([], 1, 500, 0));

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      const result = await projectsClient.searchProjects({});

      expect(result.components).toHaveLength(0);
      expect(result.paging.total).toBe(0);
    });

    it('should propagate API errors', async () => {
      const mockGet = mock(() => {
        throw new Error('SonarQube API error: 401 Unauthorized');
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      try {
        await projectsClient.searchProjects({});
        expect(true).toBe(false); // should not reach here
      } catch (error) {
        expect((error as Error).message).toContain('SonarQube API error: 401 Unauthorized');
      }
    });

    it('should pass all params together', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.organization).toBe('my-org');
        expect(params.q).toBe('frontend');
        expect(params.p).toBe(2);
        expect(params.ps).toBe(25);
        expect(params.qualifiers).toBeUndefined();
        return createMockProjectsResponse([], 2, 25, 100);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({
        organization: 'my-org',
        q: 'frontend',
        p: 2,
        ps: 25,
      });
    });
  });

  describe('MAX_PAGE_SIZE', () => {
    it('should be 500', () => {
      expect(MAX_PAGE_SIZE).toBe(500);
    });
  });
});

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

/**
 * Tests for IssuesClient and issuesSearchCommand
 */

import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { okAsync, type ResultAsync } from '@/core/result.ts';
import type { HttpClientError } from '@/core/server/errors.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { IssuesClient } from '@/core/server/issues.ts';
import { MAX_PAGE_SIZE, ProjectsClient } from '@/core/server/projects.ts';
import { SystemClient } from '@/core/server/system.ts';
import type {
  IssuesSearchResponse,
  ProjectsSearchResponse,
  SonarQubeIssue,
} from '@/core/server/types.ts';

import { listIssues } from '../../../../src/commands/list/issues.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';

// Test constants
const DEFAULT_PAGE_SIZE = 500;
const CUSTOM_PAGE_SIZE = 100;

type MockParamValue = string | number | boolean;
type MockParams = Record<string, MockParamValue>;
type MockGetFn = (endpoint: string, params?: MockParams) => ResultAsync<unknown, HttpClientError>;

// Helper to create a mock SonarHttpClient
function createMockClient(
  mockGet: MockGetFn,
  serverUrl = 'https://sonarcloud.io',
): SonarHttpClient {
  const client = new SonarHttpClient(serverUrl, 'test-token');
  client.get = mockGet as SonarHttpClient['get'];
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
): ResultAsync<IssuesSearchResponse, HttpClientError> {
  return okAsync({
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
): ResultAsync<ProjectsSearchResponse, HttpClientError> {
  return okAsync({
    paging: { pageIndex, pageSize, total },
    components,
  });
}

describe('IssuesClient', () => {
  describe('searchIssues', () => {
    it('should call client.get with correct endpoint', async () => {
      const mockGet = mock((endpoint: string) => {
        expect(endpoint).toBe('/api/issues/search');
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });

      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should pass projects parameter as componentKeys on Cloud', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.componentKeys).toBe('my-project');
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });
    });

    it('should pass severities parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.severities).toBe('CRITICAL,BLOCKER');
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
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
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        types: 'BUG,VULNERABILITY',
      });
    });

    it('should pass issueStatuses parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.issueStatuses).toBe('OPEN,ACCEPTED');
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        issueStatuses: 'OPEN,ACCEPTED',
      });
    });

    it('should pass resolved=false parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.resolved).toBe(false);
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
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
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
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
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });
    });

    it('should pass branch parameter', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.branch).toBe('feature/test');
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
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
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
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
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
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
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        tags: 'security,performance',
      });
    });

    it('sends `componentKeys` query param for SonarCloud (sonarcloud.io)', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.componentKeys).toBe('my-project');
        expect(params?.components).toBeUndefined();
        expect(params?.projects).toBeUndefined();
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet, 'https://sonarcloud.io');
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });
    });

    it('sends `componentKeys` query param for SonarQube Cloud US (sonarqube.us)', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.componentKeys).toBe('my-project');
        expect(params?.components).toBeUndefined();
        expect(params?.projects).toBeUndefined();
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet, 'https://sonarqube.us');
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });
    });

    it('sends `components` query param for on-premise SonarQube', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.components).toBe('my-project');
        expect(params?.componentKeys).toBeUndefined();
        expect(params?.projects).toBeUndefined();
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet, 'https://sonarqube.example.com');
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });
    });

    it('sends no project param when projects is not provided', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.projects).toBeUndefined();
        expect(params?.componentKeys).toBeUndefined();
        expect(params?.components).toBeUndefined();
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet, 'https://sonarqube.example.com');
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({});
    });

    it('sends `sinceLeakPeriod` query param for SonarCloud', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.sinceLeakPeriod).toBe(true);
        expect(params?.inNewCodePeriod).toBeUndefined();
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet, 'https://sonarcloud.io');
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project', sinceLeakPeriod: true });
    });

    it('sends `inNewCodePeriod` query param for on-premise SonarQube', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.inNewCodePeriod).toBe(true);
        expect(params?.sinceLeakPeriod).toBeUndefined();
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet, 'https://sonarqube.example.com');
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project', sinceLeakPeriod: true });
    });

    it('sends no leak-period param when sinceLeakPeriod is not provided', async () => {
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.sinceLeakPeriod).toBeUndefined();
        expect(params?.inNewCodePeriod).toBeUndefined();
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });
    });

    it('should pass pagination parameters', async () => {
      const pageNum = 2;
      const pageSize = CUSTOM_PAGE_SIZE;
      const mockGet = mock((_endpoint: string, params?: MockParams) => {
        expect(params?.p).toBe(pageNum);
        expect(params?.ps).toBe(pageSize);
        return createMockIssuesResponse([], pageNum, pageSize, 0);
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
        return createMockIssuesResponse([], 1, DEFAULT_PAGE_SIZE, 0);
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
        return createMockIssuesResponse(mockIssues, 1, DEFAULT_PAGE_SIZE, twoIssues);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      const result = await issuesClient.searchIssues({ projects: 'my-project' }).orThrow();

      expect(result.issues).toHaveLength(twoIssues);
      expect(result.issues[0].key).toBe('issue-1');
      expect(result.issues[1].key).toBe('issue-2');
      expect(result.total).toBe(twoIssues);
    });
  });
});

describe('issuesSearchCommand', () => {
  const mockAuth: ResolvedAuth = {
    token: 'test-token',
    serverUrl: 'https://sonarcloud.io',
    orgKey: 'test-org',
    connectionType: 'cloud',
  };

  let fake: FakeConsole;
  let mockCtx: CommandAuthenticatedInvocationContext;

  const emptyApiResponse = {
    issues: [],
    total: 0,
    p: 1,
    ps: 500,
    paging: { pageIndex: 1, pageSize: 500, total: 0 },
  };

  beforeEach(() => {
    fake = new FakeConsole();
    mockCtx = new CommandAuthenticatedInvocationContext(mockAuth, fake);
  });

  it('throws when --project is missing', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(listIssues({ page: 1, pageSize: 500 }, mockCtx)).rejects.toThrow(
      '--project is required',
    );
  });

  it('throws when --format is invalid', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      listIssues({ project: 'proj', format: 'xml', page: 1, pageSize: 500 }, mockCtx),
    ).rejects.toThrow('xml');
  });

  it('throws when --page is 0', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(listIssues({ project: 'proj', page: 0, pageSize: 500 }, mockCtx)).rejects.toThrow(
      'page',
    );
  });

  it('throws when --page-size is 0', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(listIssues({ project: 'proj', page: 1, pageSize: 0 }, mockCtx)).rejects.toThrow(
      'page-size',
    );
  });

  it('throws when --page-size exceeds maximum', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      listIssues({ project: 'proj', page: 1, pageSize: MAX_PAGE_SIZE + 1 }, mockCtx),
    ).rejects.toThrow('page-size');
  });

  it('throws when --severities is invalid', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      listIssues({ project: 'proj', severities: 'EXTREME', page: 1, pageSize: 500 }, mockCtx),
    ).rejects.toThrow('EXTREME');
  });

  it('normalizes severities to uppercase before passing to API', async () => {
    let capturedParams: Record<string, string> | undefined;
    const getSpy = spyOn(SonarHttpClient.prototype, 'get').mockImplementation(
      <T>(_endpoint: string, params?: Record<string, string | number | boolean>) => {
        capturedParams = params as Record<string, string>;
        return okAsync(emptyApiResponse as unknown as T);
      },
    );

    try {
      await listIssues(
        { project: 'my-project', severities: 'high', page: 1, pageSize: 500 },
        mockCtx,
      );
      expect(capturedParams?.impactSeverities).toBe('HIGH');
    } finally {
      getSpy.mockRestore();
    }
  });

  it('succeeds when issues search returns results', async () => {
    const getSpy = spyOn(SonarHttpClient.prototype, 'get').mockReturnValue(
      okAsync(emptyApiResponse),
    );

    try {
      await listIssues({ project: 'my-project', page: 1, pageSize: 500 }, mockCtx);
      expect(getSpy).toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
    }
  });

  it('routes MQR severities to impactSeverities param on MQR server (SonarQube Cloud)', async () => {
    let capturedParams: Record<string, string> | undefined;
    const getSpy = spyOn(SonarHttpClient.prototype, 'get').mockImplementation(
      <T>(_endpoint: string, params?: Record<string, string | number | boolean>) => {
        capturedParams = params as Record<string, string>;
        return okAsync(emptyApiResponse as unknown as T);
      },
    );
    try {
      await listIssues(
        { project: 'my-project', severities: 'HIGH,MEDIUM', page: 1, pageSize: 500 },
        mockCtx,
      );
      expect(capturedParams?.impactSeverities).toBe('HIGH,MEDIUM');
      expect(capturedParams?.severities).toBeUndefined();
    } finally {
      getSpy.mockRestore();
    }
  });

  it('routes BLOCKER and INFO to impactSeverities on MQR server', async () => {
    let capturedParams: Record<string, string> | undefined;
    const getSpy = spyOn(SonarHttpClient.prototype, 'get').mockImplementation(
      <T>(_endpoint: string, params?: Record<string, string | number | boolean>) => {
        capturedParams = params as Record<string, string>;
        return okAsync(emptyApiResponse as unknown as T);
      },
    );
    try {
      await listIssues(
        { project: 'my-project', severities: 'BLOCKER,INFO', page: 1, pageSize: 500 },
        mockCtx,
      );
      expect(capturedParams?.impactSeverities).toBe('BLOCKER,INFO');
      expect(capturedParams?.severities).toBeUndefined();
    } finally {
      getSpy.mockRestore();
    }
  });

  it('throws when Standard-only value is used on MQR server', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      listIssues({ project: 'proj', severities: 'MAJOR', page: 1, pageSize: 500 }, mockCtx),
    ).rejects.toThrow('Invalid severity');
  });

  it('routes Standard severities to severities param on Standard server', async () => {
    let capturedParams: Record<string, string> | undefined;
    const getSpy = spyOn(SonarHttpClient.prototype, 'get').mockImplementation(
      <T>(_endpoint: string, params?: Record<string, string | number | boolean>) => {
        capturedParams = params as Record<string, string>;
        return okAsync(emptyApiResponse as unknown as T);
      },
    );
    const modeSpy = spyOn(SystemClient.prototype, 'getServerMode').mockReturnValue(
      okAsync('standard'),
    );
    try {
      await listIssues(
        { project: 'my-project', severities: 'MAJOR,CRITICAL', page: 1, pageSize: 500 },
        mockCtx,
      );
      expect(capturedParams?.severities).toBe('MAJOR,CRITICAL');
      expect(capturedParams?.impactSeverities).toBeUndefined();
    } finally {
      getSpy.mockRestore();
      modeSpy.mockRestore();
    }
  });

  it('throws when MQR-only value is used on Standard server', async () => {
    const modeSpy = spyOn(SystemClient.prototype, 'getServerMode').mockReturnValue(
      okAsync('standard'),
    );
    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        listIssues({ project: 'proj', severities: 'HIGH', page: 1, pageSize: 500 }, mockCtx),
      ).rejects.toThrow('Invalid severity');
    } finally {
      modeSpy.mockRestore();
    }
  });

  it('throws when --statuses is invalid', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      listIssues({ project: 'proj', statuses: 'UNKNOWN', page: 1, pageSize: 500 }, mockCtx),
    ).rejects.toThrow('UNKNOWN');
  });

  describe('table format', () => {
    async function printTable(issues: SonarQubeIssue[]): Promise<string> {
      const getSpy = spyOn(SonarHttpClient.prototype, 'get').mockReturnValue(
        okAsync({
          issues,
          total: issues.length,
          p: 1,
          ps: 500,
          paging: { pageIndex: 1, pageSize: 500, total: issues.length },
        }),
      );
      try {
        await listIssues(
          { project: 'my-project', format: 'table', page: 1, pageSize: 500 },
          mockCtx,
        );
        const printed = fake.calls.find((c) => c.method === 'print')?.args[0];
        expect(typeof printed).toBe('string');
        return printed as string;
      } finally {
        getSpy.mockRestore();
      }
    }

    it('prints "No issues found" when the search returns nothing', async () => {
      expect(await printTable([])).toBe('No issues found');
    });

    it('prints a header and one data row per issue', async () => {
      const output = await printTable([
        { ...createMockIssue('a'), severity: 'CRITICAL', rule: 'java:S001', message: 'Fix me' },
        createMockIssue('b'),
        createMockIssue('c'),
      ]);
      const lines = output.split('\n');
      expect(lines[0]).toContain('SEVERITY');
      expect(lines[0]).toContain('RULE');
      expect(lines[0]).toContain('MESSAGE');
      expect(lines[0]).toContain('FILE');
      expect(lines[1]).toMatch(/^-+$/);
      expect(lines[2]).toContain('CRITICAL');
      expect(lines[2]).toContain('java:S001');
      expect(lines[2]).toContain('Fix me');
      expect(lines).toHaveLength(5);
    });

    it('prints the path after the project key and the line number', async () => {
      const output = await printTable([
        {
          ...createMockIssue('a'),
          component: 'proj:src/utils/helper.ts',
          line: 42,
        },
      ]);
      expect(output).toContain('src/utils/helper.ts:42');
      expect(output).not.toContain('proj:src');
    });

    it('prints the full component and ? when the path has no colon or line', async () => {
      const output = await printTable([
        { ...createMockIssue('a'), component: 'standalone-component' },
      ]);
      expect(output).toContain('standalone-component:?');
    });

    it('widens the rule column when the rule key exceeds the minimum width', async () => {
      const longRule = 'a'.repeat(40);
      const output = await printTable([{ ...createMockIssue('a'), rule: longRule }]);
      expect(output).toContain(longRule);
    });
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

      const result = await projectsClient.searchProjects({}).orThrow();

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

      const result = await projectsClient.searchProjects({ p: 2, ps: 50 }).orThrow();

      expect(result.paging.pageIndex).toBe(2);
      expect(result.paging.pageSize).toBe(50);
      expect(result.paging.total).toBe(200);
    });

    it('should return empty list when no projects found', async () => {
      const mockGet = mock(() => createMockProjectsResponse([], 1, 500, 0));

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      const result = await projectsClient.searchProjects({}).orThrow();

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

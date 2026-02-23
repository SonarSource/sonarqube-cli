/**
 * Tests for IssuesClient and issuesSearchCommand
 */

import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { IssuesClient } from '../../src/sonarqube/issues.js';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import type { IssuesSearchResponse, SonarQubeIssue } from '../../src/lib/types.js';
import { issuesSearchCommand } from '../../src/commands/issues.js';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui';

// Test constants
const DEFAULT_PAGE_SIZE = 500;
const CUSTOM_PAGE_SIZE = 100;
const MULTI_PAGE_TOTAL = 5;
const MULTI_PAGE_COUNT = 3;
const SMALL_TOTAL = 3;
const LARGE_SET_TOTAL = 1000;
const LARGE_SET_PAGES = 10;
const LARGE_SET_LAST_INDEX = 999;

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
    type: 'BUG'
  };
}

// Helper to create a mock response
function createMockResponse(issues: SonarQubeIssue[], page: number, pageSize: number, total: number): IssuesSearchResponse {
  return {
    total,
    p: page,
    ps: pageSize,
    paging: {
      pageIndex: page,
      pageSize,
      total
    },
    issues
  };
}

describe('IssuesClient', () => {
  describe('searchIssues', () => {
    it('should call client.get with correct endpoint', async () => {
      const mockGet = mock(async (endpoint: string) => {
        expect(endpoint).toBe('/api/issues/search');
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });

      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should pass projects parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.projects).toBe('my-project');
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });
    });

    it('should pass severities parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.severities).toBe('CRITICAL,BLOCKER');
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        severities: 'CRITICAL,BLOCKER'
      });
    });

    it('should pass types parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.types).toBe('BUG,VULNERABILITY');
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        types: 'BUG,VULNERABILITY'
      });
    });

    it('should pass statuses parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.statuses).toBe('OPEN,REOPENED');
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        statuses: 'OPEN,REOPENED'
      });
    });

    it('should pass resolved=false parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.resolved).toBe(false);
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        resolved: false
      });
    });

    it('should pass resolved=true parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.resolved).toBe(true);
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        resolved: true
      });
    });

    it('should not pass resolved parameter when undefined', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.resolved).toBeUndefined();
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });
    });

    it('should pass branch parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.branch).toBe('feature/test');
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        branch: 'feature/test'
      });
    });

    it('should pass pullRequest parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.pullRequest).toBe('123');
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        pullRequest: '123'
      });
    });

    it('should pass rules parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.rules).toBe('typescript:S1234');
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        rules: 'typescript:S1234'
      });
    });

    it('should pass tags parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.tags).toBe('security,performance');
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        tags: 'security,performance'
      });
    });

    it('should pass componentKeys parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.componentKeys).toBe('my-project:src/file.ts');
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        componentKeys: 'my-project:src/file.ts'
      });
    });

    it('should pass pagination parameters', async () => {
      const pageNum = 2;
      const pageSize = CUSTOM_PAGE_SIZE;
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.p).toBe(pageNum);
        expect(params?.ps).toBe(pageSize);
        return createMockResponse([], pageNum, pageSize, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        p: pageNum,
        ps: pageSize
      });
    });

    it('should pass sort parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.s).toBe('SEVERITY');
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        s: 'SEVERITY'
      });
    });

    it('should return response with issues', async () => {
      const twoIssues = 2;
      const mockIssues = [createMockIssue('issue-1'), createMockIssue('issue-2')];
      const mockGet = mock(async () => {
        return createMockResponse(mockIssues, 1, DEFAULT_PAGE_SIZE, twoIssues);
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

  describe('searchAllIssues', () => {
    it('should fetch single page when total fits in one page', async () => {
      const twoIssues = 2;
      const mockIssues = [createMockIssue('issue-1'), createMockIssue('issue-2')];
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.p).toBe(1);
        expect(params?.ps).toBe(DEFAULT_PAGE_SIZE);
        return createMockResponse(mockIssues, 1, DEFAULT_PAGE_SIZE, twoIssues);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      const result = await issuesClient.searchAllIssues({ projects: 'my-project' });

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.issues).toHaveLength(twoIssues);
      expect(result.total).toBe(twoIssues);
    });

    it('should fetch multiple pages and aggregate issues', async () => {
      let callCount = 0;
      const pageSizeSmall = 2;
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        callCount++;

        if (params?.p === 1) {
          return createMockResponse(
            [createMockIssue('issue-1'), createMockIssue('issue-2')],
            1,
            pageSizeSmall,
            MULTI_PAGE_TOTAL // total 5 issues across 3 pages
          );
        } else if (params?.p === 2) {
          return createMockResponse(
            [createMockIssue('issue-3'), createMockIssue('issue-4')],
            2,
            pageSizeSmall,
            MULTI_PAGE_TOTAL
          );
        } else if (params?.p === MULTI_PAGE_COUNT) {
          return createMockResponse(
            [createMockIssue('issue-5')],
            MULTI_PAGE_COUNT,
            pageSizeSmall,
            MULTI_PAGE_TOTAL
          );
        }

        throw new Error('Unexpected page number');
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      const result = await issuesClient.searchAllIssues({
        projects: 'my-project',
        ps: pageSizeSmall
      });

      expect(mockGet).toHaveBeenCalledTimes(MULTI_PAGE_COUNT);
      expect(result.issues).toHaveLength(MULTI_PAGE_TOTAL);
      expect(result.issues[0].key).toBe('issue-1');
      expect(result.issues[2].key).toBe('issue-3');
      expect(result.issues[4].key).toBe('issue-5');
      expect(result.total).toBe(MULTI_PAGE_TOTAL);
    });

    it('should use default page size of 500 when not specified', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.ps).toBe(DEFAULT_PAGE_SIZE);
        return createMockResponse([], 1, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchAllIssues({ projects: 'my-project' });

      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should respect custom page size', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.ps).toBe(CUSTOM_PAGE_SIZE);
        return createMockResponse([], 1, CUSTOM_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchAllIssues({
        projects: 'my-project',
        ps: CUSTOM_PAGE_SIZE
      });

      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should preserve metadata from last response', async () => {
      const mockComponents = [{ key: 'comp-1', name: 'Component 1', qualifier: 'FIL' }];
      const mockRules = [{ key: 'typescript:S1234', name: 'Rule 1' }];
      const pageSizeSmall = 2;

      let callCount = 0;
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        callCount++;
        const response = createMockResponse(
          [createMockIssue(`issue-${callCount}`)],
          params?.p as number,
          pageSizeSmall,
          SMALL_TOTAL
        );
        response.components = mockComponents;
        response.rules = mockRules;
        return response;
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      const result = await issuesClient.searchAllIssues({
        projects: 'my-project',
        ps: pageSizeSmall
      });

      expect(result.components).toEqual(mockComponents);
      expect(result.rules).toEqual(mockRules);
      expect(result.issues).toHaveLength(pageSizeSmall);
    });

    it('should override total with aggregated count', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        if (params?.p === 1) {
          return createMockResponse([createMockIssue('issue-1')], 1, 1, SMALL_TOTAL);
        } else if (params?.p === 2) {
          return createMockResponse([createMockIssue('issue-2')], 2, 1, SMALL_TOTAL);
        } else if (params?.p === SMALL_TOTAL) {
          return createMockResponse([createMockIssue('issue-3')], SMALL_TOTAL, 1, SMALL_TOTAL);
        }
        throw new Error('Unexpected page');
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      const result = await issuesClient.searchAllIssues({
        projects: 'my-project',
        ps: 1
      });

      // Original total from API is 3, but we override with actual aggregated count
      expect(result.total).toBe(SMALL_TOTAL);
      expect(result.issues).toHaveLength(SMALL_TOTAL);
    });

    it('should pass all filter parameters through pagination', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        expect(params?.projects).toBe('my-project');
        expect(params?.severities).toBe('CRITICAL');
        expect(params?.resolved).toBe(false);
        expect(params?.branch).toBe('main');
        return createMockResponse([], params?.p as number, DEFAULT_PAGE_SIZE, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchAllIssues({
        projects: 'my-project',
        severities: 'CRITICAL',
        resolved: false,
        branch: 'main'
      });
    });

    it('should handle large paginated result sets', async () => {
      const mockGet = mock(async (_endpoint: string, params?: MockParams) => {
        // Simulate 1000 issues across 10 pages
        const pageNum = params?.p as number;
        const issues = Array.from({ length: CUSTOM_PAGE_SIZE }, (_, i) =>
          createMockIssue(`issue-${(pageNum - 1) * CUSTOM_PAGE_SIZE + i + 1}`)
        );
        return createMockResponse(issues, pageNum, CUSTOM_PAGE_SIZE, LARGE_SET_TOTAL);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      const result = await issuesClient.searchAllIssues({
        projects: 'my-project',
        ps: CUSTOM_PAGE_SIZE
      });

      expect(mockGet).toHaveBeenCalledTimes(LARGE_SET_PAGES);
      expect(result.issues).toHaveLength(LARGE_SET_TOTAL);
      expect(result.issues[0].key).toBe('issue-1');
      expect(result.issues[LARGE_SET_LAST_INDEX].key).toBe('issue-1000');
      expect(result.total).toBe(LARGE_SET_TOTAL);
    });
  });
});

describe('issuesSearchCommand', () => {
  let mockExit: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when --project is missing', async () => {
    await issuesSearchCommand({ server: 'https://sonarcloud.io', token: 'fake-token' });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when --format is invalid', async () => {
    clearMockUiCalls();
    await issuesSearchCommand({ server: 'https://sonarcloud.io', token: 'tok', project: 'proj', format: 'xml' });
    expect(mockExit).toHaveBeenCalledWith(1);
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('Invalid format') && m.includes('xml'))).toBe(true);
  });

  it('exits 1 when --page-size is not a number', async () => {
    clearMockUiCalls();
    await issuesSearchCommand({ server: 'https://sonarcloud.io', token: 'tok', project: 'proj', pageSize: 'abc' as unknown as number });
    expect(mockExit).toHaveBeenCalledWith(1);
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('page-size'))).toBe(true);
  });

  it('exits 1 when --page-size is 0', async () => {
    clearMockUiCalls();
    await issuesSearchCommand({ server: 'https://sonarcloud.io', token: 'tok', project: 'proj', pageSize: 0 });
    expect(mockExit).toHaveBeenCalledWith(1);
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('page-size'))).toBe(true);
  });

  it('exits 1 when --page-size exceeds 500', async () => {
    clearMockUiCalls();
    await issuesSearchCommand({ server: 'https://sonarcloud.io', token: 'tok', project: 'proj', pageSize: 501 });
    expect(mockExit).toHaveBeenCalledWith(1);
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('page-size'))).toBe(true);
  });

  it('exits 1 when --severity is invalid', async () => {
    clearMockUiCalls();
    await issuesSearchCommand({ server: 'https://sonarcloud.io', token: 'tok', project: 'proj', severity: 'EXTREME' });
    expect(mockExit).toHaveBeenCalledWith(1);
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('severity') && m.includes('EXTREME'))).toBe(true);
  });

  it('exits 1 when --server is not a valid URL', async () => {
    clearMockUiCalls();
    await issuesSearchCommand({ server: 'not-a-url', token: 'tok', project: 'proj' });
    expect(mockExit).toHaveBeenCalledWith(1);
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('Invalid server URL') && m.includes('not-a-url'))).toBe(true);
  });

  it('normalizes severity to uppercase before passing to API', async () => {
    let capturedSeverities: string | undefined;
    const getSpy = spyOn(SonarQubeClient.prototype, 'get')
      .mockImplementation(async <T>(_endpoint: string, params?: Record<string, string | number | boolean>): Promise<T> => {
        capturedSeverities = (params as Record<string, string>)?.severities;
        return { issues: [], total: 0, p: 1, ps: 500, paging: { pageIndex: 1, pageSize: 500, total: 0 } } as unknown as T;
      });

    try {
      await issuesSearchCommand({
        server: 'https://sonarcloud.io',
        token: 'test-token',
        project: 'my-project',
        severity: 'major',
      });
      expect(capturedSeverities).toBe('MAJOR');
    } finally {
      getSpy.mockRestore();
    }
  });

  it('exits 0 when issues search succeeds', async () => {
    const getSpy = spyOn(SonarQubeClient.prototype, 'get').mockResolvedValue({
      issues: [],
      total: 0,
      p: 1,
      ps: 500,
      paging: { pageIndex: 1, pageSize: 500, total: 0 },
    });

    try {
      await issuesSearchCommand({
        server: 'https://sonarcloud.io',
        token: 'test-token',
        project: 'my-project',
      });
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      getSpy.mockRestore();
    }
  });
});

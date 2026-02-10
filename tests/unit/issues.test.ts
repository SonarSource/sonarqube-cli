/**
 * Tests for IssuesClient
 */

import { describe, it, expect, mock } from 'bun:test';
import { IssuesClient } from '../../src/sonarqube/issues.js';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import type { IssuesSearchResponse, SonarQubeIssue } from '../../src/lib/types.js';

// Helper to create a mock SonarQubeClient
function createMockClient(mockGet: any): SonarQubeClient {
  const client = new SonarQubeClient('https://sonarcloud.io', 'test-token');
  client.get = mockGet;
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
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });

      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should pass projects parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.projects).toBe('my-project');
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });
    });

    it('should pass severities parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.severities).toBe('CRITICAL,BLOCKER');
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        severities: 'CRITICAL,BLOCKER'
      });
    });

    it('should pass types parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.types).toBe('BUG,VULNERABILITY');
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        types: 'BUG,VULNERABILITY'
      });
    });

    it('should pass statuses parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.statuses).toBe('OPEN,REOPENED');
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        statuses: 'OPEN,REOPENED'
      });
    });

    it('should pass resolved=false parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.resolved).toBe(false);
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        resolved: false
      });
    });

    it('should pass resolved=true parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.resolved).toBe(true);
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        resolved: true
      });
    });

    it('should not pass resolved parameter when undefined', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.resolved).toBeUndefined();
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({ projects: 'my-project' });
    });

    it('should pass branch parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.branch).toBe('feature/test');
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        branch: 'feature/test'
      });
    });

    it('should pass pullRequest parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.pullRequest).toBe('123');
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        pullRequest: '123'
      });
    });

    it('should pass rules parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.rules).toBe('typescript:S1234');
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        rules: 'typescript:S1234'
      });
    });

    it('should pass tags parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.tags).toBe('security,performance');
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        tags: 'security,performance'
      });
    });

    it('should pass componentKeys parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.componentKeys).toBe('my-project:src/file.ts');
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        componentKeys: 'my-project:src/file.ts'
      });
    });

    it('should pass pagination parameters', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.p).toBe(2);
        expect(params.ps).toBe(100);
        return createMockResponse([], 2, 100, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        p: 2,
        ps: 100
      });
    });

    it('should pass sort parameter', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.s).toBe('SEVERITY');
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchIssues({
        projects: 'my-project',
        s: 'SEVERITY'
      });
    });

    it('should return response with issues', async () => {
      const mockIssues = [createMockIssue('issue-1'), createMockIssue('issue-2')];
      const mockGet = mock(async () => {
        return createMockResponse(mockIssues, 1, 500, 2);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      const result = await issuesClient.searchIssues({ projects: 'my-project' });

      expect(result.issues).toHaveLength(2);
      expect(result.issues[0].key).toBe('issue-1');
      expect(result.issues[1].key).toBe('issue-2');
      expect(result.total).toBe(2);
    });
  });

  describe('searchAllIssues', () => {
    it('should fetch single page when total fits in one page', async () => {
      const mockIssues = [createMockIssue('issue-1'), createMockIssue('issue-2')];
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.p).toBe(1);
        expect(params.ps).toBe(500);
        return createMockResponse(mockIssues, 1, 500, 2);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      const result = await issuesClient.searchAllIssues({ projects: 'my-project' });

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.issues).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should fetch multiple pages and aggregate issues', async () => {
      let callCount = 0;
      const mockGet = mock(async (_endpoint: string, params: any) => {
        callCount++;
        
        if (params.p === 1) {
          return createMockResponse(
            [createMockIssue('issue-1'), createMockIssue('issue-2')],
            1,
            2,
            5 // total 5 issues across 3 pages
          );
        } else if (params.p === 2) {
          return createMockResponse(
            [createMockIssue('issue-3'), createMockIssue('issue-4')],
            2,
            2,
            5
          );
        } else if (params.p === 3) {
          return createMockResponse(
            [createMockIssue('issue-5')],
            3,
            2,
            5
          );
        }
        
        throw new Error('Unexpected page number');
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      const result = await issuesClient.searchAllIssues({
        projects: 'my-project',
        ps: 2
      });

      expect(mockGet).toHaveBeenCalledTimes(3);
      expect(result.issues).toHaveLength(5);
      expect(result.issues[0].key).toBe('issue-1');
      expect(result.issues[2].key).toBe('issue-3');
      expect(result.issues[4].key).toBe('issue-5');
      expect(result.total).toBe(5);
    });

    it('should use default page size of 500 when not specified', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.ps).toBe(500);
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchAllIssues({ projects: 'my-project' });

      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should respect custom page size', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.ps).toBe(100);
        return createMockResponse([], 1, 100, 0);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      await issuesClient.searchAllIssues({
        projects: 'my-project',
        ps: 100
      });

      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should preserve metadata from last response', async () => {
      const mockComponents = [{ key: 'comp-1', name: 'Component 1', qualifier: 'FIL' }];
      const mockRules = [{ key: 'typescript:S1234', name: 'Rule 1' }];

      let callCount = 0;
      const mockGet = mock(async (_endpoint: string, params: any) => {
        callCount++;
        const response = createMockResponse(
          [createMockIssue(`issue-${callCount}`)],
          params.p,
          2,
          3
        );
        response.components = mockComponents;
        response.rules = mockRules;
        return response;
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      const result = await issuesClient.searchAllIssues({
        projects: 'my-project',
        ps: 2
      });

      expect(result.components).toEqual(mockComponents);
      expect(result.rules).toEqual(mockRules);
      expect(result.issues).toHaveLength(2);
    });

    it('should override total with aggregated count', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        if (params.p === 1) {
          return createMockResponse([createMockIssue('issue-1')], 1, 1, 3);
        } else if (params.p === 2) {
          return createMockResponse([createMockIssue('issue-2')], 2, 1, 3);
        } else if (params.p === 3) {
          return createMockResponse([createMockIssue('issue-3')], 3, 1, 3);
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
      expect(result.total).toBe(3);
      expect(result.issues).toHaveLength(3);
    });

    it('should pass all filter parameters through pagination', async () => {
      const mockGet = mock(async (_endpoint: string, params: any) => {
        expect(params.projects).toBe('my-project');
        expect(params.severities).toBe('CRITICAL');
        expect(params.resolved).toBe(false);
        expect(params.branch).toBe('main');
        return createMockResponse([], params.p, 500, 0);
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
      const mockGet = mock(async (_endpoint: string, params: any) => {
        // Simulate 1000 issues across 10 pages
        const issues = Array.from({ length: 100 }, (_, i) => 
          createMockIssue(`issue-${(params.p - 1) * 100 + i + 1}`)
        );
        return createMockResponse(issues, params.p, 100, 1000);
      });

      const client = createMockClient(mockGet);
      const issuesClient = new IssuesClient(client);

      const result = await issuesClient.searchAllIssues({
        projects: 'my-project',
        ps: 100
      });

      expect(mockGet).toHaveBeenCalledTimes(10);
      expect(result.issues).toHaveLength(1000);
      expect(result.issues[0].key).toBe('issue-1');
      expect(result.issues[999].key).toBe('issue-1000');
      expect(result.total).toBe(1000);
    });
  });
});

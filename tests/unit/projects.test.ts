/**
 * Tests for ProjectsClient
 */

import { describe, it, expect, mock } from 'bun:test';
import { ProjectsClient, MAX_PAGE_SIZE } from '../../src/sonarqube/projects.js';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import type { ProjectsSearchResponse } from '../../src/lib/types.js';

// Helper to create a mock SonarQubeClient
function createMockClient(mockGet: any): SonarQubeClient {
  const client = new SonarQubeClient('https://sonarcloud.io', 'test-token');
  client.get = mockGet;
  return client;
}

// Helper to create a mock project component
function createMockProject(key: string, name: string = `Project ${key}`) {
  return { key, name };
}

// Helper to create a mock API response
function createMockResponse(
  components: { key: string; name: string }[],
  pageIndex: number,
  pageSize: number,
  total: number,
): ProjectsSearchResponse {
  return {
    paging: { pageIndex, pageSize, total },
    components,
  };
}

describe('ProjectsClient', () => {
  describe('searchProjects', () => {
    it('should call client.get with correct endpoint', async () => {
      const mockGet = mock((endpoint: string) => {
        expect(endpoint).toBe('/api/components/search');
        return createMockResponse([], 1, 500, 0);
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
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({});
    });

    it('should send qualifiers=TRK when organization is undefined', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.qualifiers).toBe('TRK');
        expect(params.organization).toBeUndefined();
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({ organization: undefined });
    });

    it('should send organization param and omit qualifiers for SonarCloud', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.organization).toBe('my-org');
        expect(params.qualifiers).toBeUndefined();
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({ organization: 'my-org' });
    });

    it('should pass search query parameter', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.q).toBe('my-project');
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({ q: 'my-project' });
    });

    it('should not send query param when not specified', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.q).toBeUndefined();
        return createMockResponse([], 1, 500, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({});
    });

    it('should pass page number', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.p).toBe(3);
        return createMockResponse([], 3, 500, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({ p: 3 });
    });

    it('should pass page size', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.ps).toBe(50);
        return createMockResponse([], 1, 50, 0);
      });

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      await projectsClient.searchProjects({ ps: 50 });
    });

    it('should not send page params when not specified', async () => {
      const mockGet = mock((_endpoint: string, params: any) => {
        expect(params.p).toBeUndefined();
        expect(params.ps).toBeUndefined();
        return createMockResponse([], 1, 500, 0);
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
      const mockGet = mock(() => createMockResponse(mockProjects, 1, 500, 2));

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
      const mockGet = mock(() => createMockResponse([], 2, 50, 200));

      const client = createMockClient(mockGet);
      const projectsClient = new ProjectsClient(client);

      const result = await projectsClient.searchProjects({ p: 2, ps: 50 });

      expect(result.paging.pageIndex).toBe(2);
      expect(result.paging.pageSize).toBe(50);
      expect(result.paging.total).toBe(200);
    });

    it('should return empty list when no projects found', async () => {
      const mockGet = mock(() => createMockResponse([], 1, 500, 0));

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
        return createMockResponse([], 2, 25, 100);
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

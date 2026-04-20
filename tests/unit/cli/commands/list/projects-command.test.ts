/**
 * Tests for projects search command logic
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { listProjects, ListProjectsOptions } from '../../../../../src/cli/commands/list/projects';
import type { ResolvedAuth } from '../../../../../src/lib/auth-resolver.js';
import type { ProjectsSearchResponse } from '../../../../../src/lib/types.js';
import { SonarQubeClient } from '../../../../../src/sonarqube/client.js';
import { MAX_PAGE_SIZE } from '../../../../../src/sonarqube/projects.js';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../src/ui';

const DEFAULT_OPTIONS: ListProjectsOptions = {
  page: 1,
  pageSize: 500,
};

const mockAuth: ResolvedAuth = {
  token: 'test-token',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'on-premise',
};

function makeProjectsResponse(
  components: { key: string; name: string }[],
  pageIndex = 1,
  pageSize = 500,
  total = components.length,
): ProjectsSearchResponse {
  return { paging: { pageIndex, pageSize, total }, components };
}

beforeEach(() => {
  setMockUi(true);
});

afterEach(() => {
  setMockUi(false);
});

describe('projectsSearchCommand', () => {
  let getSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getSpy = spyOn(SonarQubeClient.prototype, 'get').mockResolvedValue(makeProjectsResponse([]));
  });

  afterEach(() => {
    getSpy.mockRestore();
  });

  describe('error conditions', () => {
    it('throws when page size is not positive', () => {
      expect(listProjects({ page: 1, pageSize: 0 }, mockAuth)).rejects.toThrow(
        `Invalid --page-size option: '0'. Must be an integer between 1 and 500`,
      );
    });

    it('throws when page is not positive', () => {
      expect(listProjects({ page: 0, pageSize: 500 }, mockAuth)).rejects.toThrow(
        `Invalid --page option: '0'. Must be an integer >= 1`,
      );
    });

    it('throws when page size exceeds the maximum', () => {
      expect(listProjects({ page: 1, pageSize: MAX_PAGE_SIZE + 1 }, mockAuth)).rejects.toThrow(
        `Invalid --page-size option: '${MAX_PAGE_SIZE + 1}'. Must be an integer between 1 and 500`,
      );
    });

    it('propagates API errors', () => {
      getSpy.mockRejectedValue(new Error('SonarQube API error: 401 Unauthorized'));

      expect(listProjects(DEFAULT_OPTIONS, mockAuth)).rejects.toThrow(
        'SonarQube API error: 401 Unauthorized',
      );
    });
  });

  describe('successful execution', () => {
    it('prints JSON with empty projects array when no results', async () => {
      clearMockUiCalls();

      await listProjects(DEFAULT_OPTIONS, mockAuth);

      const prints = getMockUiCalls()
        .filter((c) => c.method === 'print')
        .map((c) => JSON.parse(String(c.args[0])) as Record<string, unknown>);
      expect(prints).toHaveLength(1);
      const first = prints[0] as {
        projects: unknown;
        paging: { total: number; hasNextPage: boolean };
      };
      expect(first.projects).toEqual([]);
      expect(first.paging.total).toBe(0);
      expect(first.paging.hasNextPage).toBe(false);
    });

    it('prints JSON with mapped projects (key and name only)', async () => {
      clearMockUiCalls();
      getSpy.mockResolvedValue(
        makeProjectsResponse([
          { key: 'proj-1', name: 'Project One' },
          { key: 'proj-2', name: 'Project Two' },
        ]),
      );

      await listProjects(DEFAULT_OPTIONS, mockAuth);

      const prints = getMockUiCalls()
        .filter((c) => c.method === 'print')
        .map((c) => JSON.parse(String(c.args[0])) as Record<string, unknown>);
      expect((prints[0] as { projects: unknown }).projects).toEqual([
        { key: 'proj-1', name: 'Project One' },
        { key: 'proj-2', name: 'Project Two' },
      ]);
    });

    it('includes correct paging metadata with hasNextPage=true when more pages exist', async () => {
      clearMockUiCalls();
      getSpy.mockResolvedValue(
        makeProjectsResponse([{ key: 'proj-1', name: 'Project One' }], 1, 1, 5),
      );

      await listProjects({ pageSize: 1, page: 1 }, mockAuth);

      const prints = getMockUiCalls()
        .filter((c) => c.method === 'print')
        .map((c) => JSON.parse(String(c.args[0])) as Record<string, unknown>);
      expect((prints[0] as { paging: unknown }).paging).toEqual({
        pageIndex: 1,
        pageSize: 1,
        total: 5,
        hasNextPage: true,
      });
    });

    it('includes correct paging metadata with hasNextPage=false on the last page', async () => {
      clearMockUiCalls();
      getSpy.mockResolvedValue(
        makeProjectsResponse([{ key: 'proj-1', name: 'Project One' }], 2, 1, 2),
      );

      await listProjects({ pageSize: 1, page: 2 }, mockAuth);

      const prints = getMockUiCalls()
        .filter((c) => c.method === 'print')
        .map((c) => JSON.parse(String(c.args[0])) as Record<string, unknown>);
      expect((prints[0] as { paging: { hasNextPage: boolean } }).paging.hasNextPage).toBe(false);
    });

    it('passes query option to the API', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation((_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await listProjects({ query: 'my-project', ...DEFAULT_OPTIONS }, mockAuth);

      expect(capturedParams?.q).toBe('my-project');
    });

    it('passes page option to the API', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation((_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await listProjects({ page: 3, pageSize: 500 }, mockAuth);

      expect(capturedParams?.p).toBe(3);
    });

    it('passes page size option to the API', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation((_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await listProjects({ page: 1, pageSize: 50 }, mockAuth);

      expect(capturedParams?.ps).toBe(50);
    });

    it('passes organization key for SonarCloud connections', async () => {
      const cloudAuth: ResolvedAuth = {
        token: 'cloud-token',
        serverUrl: 'https://sonarcloud.io',
        orgKey: 'my-org',
        connectionType: 'cloud',
      };

      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation((_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await listProjects(DEFAULT_OPTIONS, cloudAuth);

      expect(capturedParams?.organization).toBe('my-org');
    });

    it('does not pass organization key for on-premise connections', async () => {
      const onPremAuth: ResolvedAuth = {
        token: 'test-token',
        serverUrl: 'https://sonar.example.com',
        connectionType: 'on-premise',
      };

      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation((_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await listProjects(DEFAULT_OPTIONS, onPremAuth);

      expect(capturedParams?.organization).toBeUndefined();
    });
  });
});

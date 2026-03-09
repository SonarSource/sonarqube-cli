/**
 * Tests for projects search command logic
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { MAX_PAGE_SIZE } from '../../src/sonarqube/projects.js';
import { listProjects, ListProjectsOptions } from '../../src/cli/commands/list/projects';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import * as authResolver from '../../src/lib/auth-resolver.js';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui';
import type { ProjectsSearchResponse } from '../../src/lib/types.js';

const DEFAULT_OPTIONS: ListProjectsOptions = {
  page: 1,
  pageSize: 500,
};

const mockAuth = {
  token: 'test-token',
  serverUrl: 'https://sonar.example.com',
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
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let getSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue(mockAuth);
    getSpy = spyOn(SonarQubeClient.prototype, 'get').mockResolvedValue(
      makeProjectsResponse([]) as unknown as never,
    );
  });

  afterEach(() => {
    resolveAuthSpy.mockRestore();
    getSpy.mockRestore();
  });

  it('calls resolveAuth', async () => {
    await listProjects(DEFAULT_OPTIONS);

    expect(resolveAuthSpy).toHaveBeenCalledWith({ org: undefined });
  });

  it('passes --org to resolveAuth', async () => {
    await listProjects({ ...DEFAULT_OPTIONS, org: 'my-org' });

    expect(resolveAuthSpy).toHaveBeenCalledWith({ org: 'my-org' });
  });

  it('propagates auth errors', () => {
    resolveAuthSpy.mockRejectedValue(new Error('Not authenticated. Run: sonar auth login'));

    expect(listProjects(DEFAULT_OPTIONS)).rejects.toThrow('sonar auth login');
  });

  describe('error conditions', () => {
    it('throws when page size is not positive', () => {
      expect(listProjects({ page: 1, pageSize: 0 })).rejects.toThrow(
        `Invalid --page-size option: '0'. Must be an integer between 1 and 500`,
      );
    });

    it('throws when page is not positive', () => {
      expect(listProjects({ page: 0, pageSize: 500 })).rejects.toThrow(
        `Invalid --page option: '0'. Must be an integer >= 1`,
      );
    });

    it('throws when page size exceeds the maximum', () => {
      expect(listProjects({ page: 1, pageSize: MAX_PAGE_SIZE + 1 })).rejects.toThrow(
        `Invalid --page-size option: '${MAX_PAGE_SIZE + 1}'. Must be an integer between 1 and 500`,
      );
    });

    it('propagates API errors', () => {
      getSpy.mockRejectedValue(new Error('SonarQube API error: 401 Unauthorized'));

      expect(listProjects(DEFAULT_OPTIONS)).rejects.toThrow(
        'SonarQube API error: 401 Unauthorized',
      );
    });
  });

  describe('successful execution', () => {
    it('prints JSON with empty projects array when no results', async () => {
      clearMockUiCalls();

      await listProjects(DEFAULT_OPTIONS);

      const prints = getMockUiCalls()
        .filter((c) => c.method === 'print')
        .map((c) => JSON.parse(String(c.args[0])) as Record<string, unknown>);
      expect(prints).toHaveLength(1);
      expect(prints[0].projects).toEqual([]);
      expect(prints[0].paging.total).toBe(0);
      expect(prints[0].paging.hasNextPage).toBe(false);
    });

    it('prints JSON with mapped projects (key and name only)', async () => {
      clearMockUiCalls();
      getSpy.mockResolvedValue(
        makeProjectsResponse([
          { key: 'proj-1', name: 'Project One' },
          { key: 'proj-2', name: 'Project Two' },
        ]) as unknown as never,
      );

      await listProjects(DEFAULT_OPTIONS);

      const prints = getMockUiCalls()
        .filter((c) => c.method === 'print')
        .map((c) => JSON.parse(String(c.args[0])) as Record<string, unknown>);
      expect(prints[0].projects).toEqual([
        { key: 'proj-1', name: 'Project One' },
        { key: 'proj-2', name: 'Project Two' },
      ]);
    });

    it('includes correct paging metadata with hasNextPage=true when more pages exist', async () => {
      clearMockUiCalls();
      getSpy.mockResolvedValue(
        makeProjectsResponse([{ key: 'proj-1', name: 'Project One' }], 1, 1, 5) as unknown as never,
      );

      await listProjects({ pageSize: 1, page: 1 });

      const prints = getMockUiCalls()
        .filter((c) => c.method === 'print')
        .map((c) => JSON.parse(String(c.args[0])) as Record<string, unknown>);
      expect(prints[0].paging).toEqual({ pageIndex: 1, pageSize: 1, total: 5, hasNextPage: true });
    });

    it('includes correct paging metadata with hasNextPage=false on the last page', async () => {
      clearMockUiCalls();
      getSpy.mockResolvedValue(
        makeProjectsResponse([{ key: 'proj-1', name: 'Project One' }], 2, 1, 2) as unknown as never,
      );

      await listProjects({ pageSize: 1, page: 2 });

      const prints = getMockUiCalls()
        .filter((c) => c.method === 'print')
        .map((c) => JSON.parse(String(c.args[0])) as Record<string, unknown>);
      expect(prints[0].paging.hasNextPage).toBe(false);
    });

    it('passes query option to the API', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation((_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await listProjects({ query: 'my-project', ...DEFAULT_OPTIONS });

      expect(capturedParams?.q).toBe('my-project');
    });

    it('passes page option to the API', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation((_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await listProjects({ page: 3, pageSize: 500 });

      expect(capturedParams?.p).toBe(3);
    });

    it('passes page size option to the API', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation((_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await listProjects({ page: 1, pageSize: 50 });

      expect(capturedParams?.ps).toBe(50);
    });

    it('passes organization key for SonarCloud connections', async () => {
      resolveAuthSpy.mockResolvedValue({
        token: 'cloud-token',
        serverUrl: 'https://sonarcloud.io',
        orgKey: 'my-org',
      });

      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation((_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await listProjects(DEFAULT_OPTIONS);

      expect(capturedParams?.organization).toBe('my-org');
    });

    it('does not pass organization key for on-premise connections', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation((_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await listProjects(DEFAULT_OPTIONS);

      expect(capturedParams?.organization).toBeUndefined();
    });
  });
});

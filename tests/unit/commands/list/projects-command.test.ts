/**
 * Tests for projects search command logic
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import { MAX_PAGE_SIZE } from '@/core/server/projects.ts';
import type { ProjectsSearchResponse } from '@/core/server/types.ts';

import { listProjects, ListProjectsOptions } from '../../../../src/commands/list/projects.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';

const DEFAULT_OPTIONS: ListProjectsOptions = {
  page: 1,
  pageSize: 500,
};

const mockAuth: ResolvedAuth = {
  token: 'test-token',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'on-premise',
};

let fake: FakeConsole;
let mockCtx: CommandAuthenticatedInvocationContext;

function makeProjectsResponse(
  components: { key: string; name: string }[],
  pageIndex = 1,
  pageSize = 500,
  total = components.length,
): ProjectsSearchResponse {
  return { paging: { pageIndex, pageSize, total }, components };
}

beforeEach(() => {
  fake = new FakeConsole();
  mockCtx = new CommandAuthenticatedInvocationContext(mockAuth, fake);
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
    it('throws when page size is not positive', async () => {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(listProjects({ page: 1, pageSize: 0 }, mockCtx)).rejects.toThrow(
        `Invalid --page-size option: '0'. Must be an integer between 1 and 500`,
      );
    });

    it('throws when page is not positive', async () => {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(listProjects({ page: 0, pageSize: 500 }, mockCtx)).rejects.toThrow(
        `Invalid --page option: '0'. Must be an integer >= 1`,
      );
    });

    it('throws when page size exceeds the maximum', async () => {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(listProjects({ page: 1, pageSize: MAX_PAGE_SIZE + 1 }, mockCtx)).rejects.toThrow(
        `Invalid --page-size option: '${MAX_PAGE_SIZE + 1}'. Must be an integer between 1 and 500`,
      );
    });

    it('propagates API errors', async () => {
      getSpy.mockRejectedValue(new Error('SonarQube API error: 401 Unauthorized'));

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(listProjects(DEFAULT_OPTIONS, mockCtx)).rejects.toThrow(
        'SonarQube API error: 401 Unauthorized',
      );
    });
  });

  describe('successful execution', () => {
    it('prints JSON with empty projects array when no results', async () => {
      await listProjects(DEFAULT_OPTIONS, mockCtx);

      const prints = fake.calls
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
      getSpy.mockResolvedValue(
        makeProjectsResponse([
          { key: 'proj-1', name: 'Project One' },
          { key: 'proj-2', name: 'Project Two' },
        ]),
      );

      await listProjects(DEFAULT_OPTIONS, mockCtx);

      const prints = fake.calls
        .filter((c) => c.method === 'print')
        .map((c) => JSON.parse(String(c.args[0])) as Record<string, unknown>);
      expect((prints[0] as { projects: unknown }).projects).toEqual([
        { key: 'proj-1', name: 'Project One' },
        { key: 'proj-2', name: 'Project Two' },
      ]);
    });

    it('includes correct paging metadata with hasNextPage=true when more pages exist', async () => {
      getSpy.mockResolvedValue(
        makeProjectsResponse([{ key: 'proj-1', name: 'Project One' }], 1, 1, 5),
      );

      await listProjects({ pageSize: 1, page: 1 }, mockCtx);

      const prints = fake.calls
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
      getSpy.mockResolvedValue(
        makeProjectsResponse([{ key: 'proj-1', name: 'Project One' }], 2, 1, 2),
      );

      await listProjects({ pageSize: 1, page: 2 }, mockCtx);

      const prints = fake.calls
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

      await listProjects({ query: 'my-project', ...DEFAULT_OPTIONS }, mockCtx);

      expect(capturedParams?.q).toBe('my-project');
    });

    it('passes page option to the API', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation((_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await listProjects({ page: 3, pageSize: 500 }, mockCtx);

      expect(capturedParams?.p).toBe(3);
    });

    it('passes page size option to the API', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation((_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await listProjects({ page: 1, pageSize: 50 }, mockCtx);

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

      await listProjects(
        DEFAULT_OPTIONS,
        new CommandAuthenticatedInvocationContext(cloudAuth, new FakeConsole()),
      );

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

      await listProjects(
        DEFAULT_OPTIONS,
        new CommandAuthenticatedInvocationContext(onPremAuth, new FakeConsole()),
      );

      expect(capturedParams?.organization).toBeUndefined();
    });
  });
});

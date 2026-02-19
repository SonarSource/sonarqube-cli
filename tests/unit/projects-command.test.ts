/**
 * Tests for projects search command logic
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { MAX_PAGE_SIZE } from '../../src/sonarqube/projects.js';
import { projectsSearchCommand } from '../../src/commands/projects.js';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import * as stateManager from '../../src/lib/state-manager.js';
import * as keychain from '../../src/lib/keychain.js';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui/index.js';
import { getDefaultState } from '../../src/lib/state.js';
import type { AuthConnection } from '../../src/lib/state.js';
import type { ProjectsSearchResponse } from '../../src/lib/types.js';

const MOCK_CONNECTION: AuthConnection = {
  id: 'test-conn-id',
  type: 'on-premise',
  serverUrl: 'https://sonar.example.com',
  orgKey: undefined,
  authenticatedAt: new Date().toISOString(),
  keystoreKey: 'test-keystore-key',
};

const MOCK_CLOUD_CONNECTION: AuthConnection = {
  id: 'test-cloud-conn-id',
  type: 'cloud',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'my-org',
  authenticatedAt: new Date().toISOString(),
  keystoreKey: 'test-cloud-keystore-key',
};

function makeStateWithConnection(connection: AuthConnection) {
  const state = getDefaultState('test');
  state.auth.connections = [connection];
  state.auth.activeConnectionId = connection.id;
  state.auth.isAuthenticated = true;
  return state;
}

function makeProjectsResponse(
  components: { key: string; name: string }[],
  pageIndex = 1,
  pageSize = 500,
  total = components.length
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
  let loadStateSpy: ReturnType<typeof spyOn>;
  let getTokenSpy: ReturnType<typeof spyOn>;
  let getSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(
      makeStateWithConnection(MOCK_CONNECTION)
    );
    getTokenSpy = spyOn(keychain, 'getToken').mockResolvedValue('test-token');
    getSpy = spyOn(SonarQubeClient.prototype, 'get').mockResolvedValue(
      makeProjectsResponse([]) as unknown as never
    );
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    getTokenSpy.mockRestore();
    getSpy.mockRestore();
  });

  describe('error conditions', () => {
    it('throws when there is no active connection', () => {
      loadStateSpy.mockReturnValue(getDefaultState('test'));

      expect(projectsSearchCommand({})).rejects.toThrow(
        'No active connection found. Run: sonar auth login'
      );
    });

    it('throws when no token is found in the keychain', () => {
      getTokenSpy.mockResolvedValue(null);

      expect(projectsSearchCommand({})).rejects.toThrow(
        'No token found. Run: sonar auth login'
      );
    });

    it('throws when page size is not positive', () => {
      expect(projectsSearchCommand({ pageSize: 0 })).rejects.toThrow(
        `--page-size must be greater than 0 and less than or equal to ${MAX_PAGE_SIZE}`
      );
    });

    it('throws when page size exceeds the maximum', () => {
      expect(projectsSearchCommand({ pageSize: MAX_PAGE_SIZE + 1 })).rejects.toThrow(
        `--page-size must be greater than 0 and less than or equal to ${MAX_PAGE_SIZE}`
      );
    });

    it('propagates API errors', () => {
      getSpy.mockRejectedValue(new Error('SonarQube API error: 401 Unauthorized'));

      expect(projectsSearchCommand({})).rejects.toThrow(
        'SonarQube API error: 401 Unauthorized'
      );
    });
  });

  describe('successful execution', () => {
    it('prints JSON with empty projects array when no results', async () => {
      clearMockUiCalls();
      getSpy.mockResolvedValue(makeProjectsResponse([]) as unknown as never);

      await projectsSearchCommand({});

      const prints = getMockUiCalls().filter(c => c.method === 'print').map(c => JSON.parse(String(c.args[0])));
      expect(prints).toHaveLength(1);
      expect(prints[0].projects).toEqual([]);
      expect(prints[0].paging.total).toBe(0);
      expect(prints[0].paging.hasNextPage).toBe(false);
    });

    it('prints JSON with mapped projects (key and name only)', async () => {
      clearMockUiCalls();
      getSpy.mockResolvedValue(makeProjectsResponse([
        { key: 'proj-1', name: 'Project One' },
        { key: 'proj-2', name: 'Project Two' },
      ]) as unknown as never);

      await projectsSearchCommand({});

      const prints = getMockUiCalls().filter(c => c.method === 'print').map(c => JSON.parse(String(c.args[0])));
      expect(prints[0].projects).toEqual([
        { key: 'proj-1', name: 'Project One' },
        { key: 'proj-2', name: 'Project Two' },
      ]);
    });

    it('includes correct paging metadata with hasNextPage=true when more pages exist', async () => {
      clearMockUiCalls();
      getSpy.mockResolvedValue(makeProjectsResponse(
        [{ key: 'proj-1', name: 'Project One' }],
        1, 1, 5
      ) as unknown as never);

      await projectsSearchCommand({ pageSize: 1, page: 1 });

      const prints = getMockUiCalls().filter(c => c.method === 'print').map(c => JSON.parse(String(c.args[0])));
      expect(prints[0].paging).toEqual({ pageIndex: 1, pageSize: 1, total: 5, hasNextPage: true });
    });

    it('includes correct paging metadata with hasNextPage=false on the last page', async () => {
      clearMockUiCalls();
      getSpy.mockResolvedValue(makeProjectsResponse(
        [{ key: 'proj-1', name: 'Project One' }],
        2, 1, 2
      ) as unknown as never);

      await projectsSearchCommand({ pageSize: 1, page: 2 });

      const prints = getMockUiCalls().filter(c => c.method === 'print').map(c => JSON.parse(String(c.args[0])));
      expect(prints[0].paging.hasNextPage).toBe(false);
    });

    it('uses the active connection server URL to create the client', async () => {
      await projectsSearchCommand({});

      expect(getTokenSpy).toHaveBeenCalledWith(MOCK_CONNECTION.serverUrl, MOCK_CONNECTION.orgKey);
    });

    it('passes query option to the API', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation(async (_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await projectsSearchCommand({ query: 'my-project' });

      expect(capturedParams?.q).toBe('my-project');
    });

    it('passes page option to the API', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation(async (_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await projectsSearchCommand({ page: 3 });

      expect(capturedParams?.p).toBe(3);
    });

    it('passes page size option to the API', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation(async (_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await projectsSearchCommand({ pageSize: 50 });

      expect(capturedParams?.ps).toBe(50);
    });

    it('defaults to page 1 when page option is not provided', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation(async (_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await projectsSearchCommand({});

      expect(capturedParams?.p).toBe(1);
    });

    it('defaults to MAX_PAGE_SIZE when page size is not provided', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation(async (_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await projectsSearchCommand({});

      expect(capturedParams?.ps).toBe(MAX_PAGE_SIZE);
    });

    it('passes organization key for SonarCloud connections', async () => {
      loadStateSpy.mockReturnValue(makeStateWithConnection(MOCK_CLOUD_CONNECTION));
      getTokenSpy.mockResolvedValue('cloud-token');

      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation(async (_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await projectsSearchCommand({});

      expect(capturedParams?.organization).toBe('my-org');
    });

    it('does not pass organization key for on-premise connections', async () => {
      let capturedParams: Record<string, unknown> | undefined;
      getSpy.mockImplementation(async (_endpoint: string, params?: Record<string, unknown>) => {
        capturedParams = params;
        return makeProjectsResponse([]);
      });

      await projectsSearchCommand({});

      expect(capturedParams?.organization).toBeUndefined();
    });
  });
});

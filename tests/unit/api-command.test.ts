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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { apiCommand, resolveBaseUrl } from '../../src/cli/commands/api.js';
import * as discovery from '../../src/cli/commands/_common/discovery.js';
import * as apiRequestModule from '../../src/lib/api-request.js';
import { setMockUi, getMockUiCalls } from '../../src/ui/index.js';
import type { ResolvedAuth } from '../../src/lib/auth-resolver.js';
import type { ApiResponse } from '../../src/lib/api-request.js';
import type { DiscoveredProject } from '../../src/cli/commands/_common/discovery.js';

const mockAuth: ResolvedAuth = {
  token: 'test-token',
  serverUrl: 'https://sonar.example.com',
  orgKey: 'my-org',
  connectionType: 'on-premise',
};

function makeApiResponse(overrides: Partial<ApiResponse> = {}): ApiResponse {
  return {
    status: 200,
    statusText: 'OK',
    body: '{"result":"ok"}',
    headers: new Headers(),
    ...overrides,
  };
}

function makeDiscoveredProject(overrides: Partial<DiscoveredProject> = {}): DiscoveredProject {
  return {
    rootDir: '/tmp/project',
    isGitRepo: false,
    ...overrides,
  };
}

describe('apiCommand', () => {
  let discoverProjectSpy: ReturnType<typeof spyOn>;
  let apiRequestSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);

    discoverProjectSpy = spyOn(discovery, 'discoverProject').mockResolvedValue(
      makeDiscoveredProject({
        serverUrl: 'https://sonar.example.com',
        projectKey: 'my-project',
        organization: 'my-org',
      }),
    );

    apiRequestSpy = spyOn(apiRequestModule, 'apiRequest').mockResolvedValue(makeApiResponse());
  });

  afterEach(() => {
    setMockUi(false);
    discoverProjectSpy.mockRestore();
    apiRequestSpy.mockRestore();
  });

  describe('input validation', () => {
    it('rejects invalid HTTP method', () => {
      expect(apiCommand(mockAuth, 'PUT', '/api/test', {})).rejects.toThrow(
        "Invalid HTTP method 'PUT'",
      );
    });

    it('rejects endpoint not starting with /', () => {
      expect(apiCommand(mockAuth, 'get', 'api/test', {})).rejects.toThrow(
        "Endpoint must start with '/'",
      );
    });

    it('rejects --data for GET requests', () => {
      expect(apiCommand(mockAuth, 'get', '/api/test', { data: '{"key":"val"}' })).rejects.toThrow(
        '--data is only valid for POST and PATCH',
      );
    });

    it('rejects --data for DELETE requests', () => {
      expect(
        apiCommand(mockAuth, 'delete', '/api/test', { data: '{"key":"val"}' }),
      ).rejects.toThrow('--data is only valid for POST and PATCH');
    });

    it('rejects invalid JSON in --data', () => {
      expect(apiCommand(mockAuth, 'post', '/api/test', { data: 'not-json' })).rejects.toThrow(
        '--data must be valid JSON',
      );
    });
  });

  describe('successful requests', () => {
    it('makes GET request and prints body', async () => {
      await apiCommand(mockAuth, 'get', '/api/system/status', {});

      expect(apiRequestSpy).toHaveBeenCalledTimes(1);
      const [method, url, token] = apiRequestSpy.mock.calls[0] as [string, string, string];
      expect(method).toBe('GET');
      expect(url).toBe('https://sonar.example.com/api/system/status');
      expect(token).toBe('test-token');

      const printCalls = getMockUiCalls().filter((c) => c.method === 'print');
      expect(printCalls).toHaveLength(1);
      expect(printCalls[0].args[0]).toBe('{"result":"ok"}');
    });

    it('sends POST with --data body', async () => {
      const data = '{"name":"test"}';
      await apiCommand(mockAuth, 'post', '/api/create', { data });

      const [method, , , body] = apiRequestSpy.mock.calls[0] as [string, string, string, string];
      expect(method).toBe('POST');
      expect(body).toBe(data);
    });

    it('sends PATCH with --data body', async () => {
      const data = '{"name":"updated"}';
      await apiCommand(mockAuth, 'patch', '/api/update', { data });

      const [method, , , body] = apiRequestSpy.mock.calls[0] as [string, string, string, string];
      expect(method).toBe('PATCH');
      expect(body).toBe(data);
    });

    it('accepts case-insensitive method names', async () => {
      await apiCommand(mockAuth, 'GET', '/api/test', {});

      const [method] = apiRequestSpy.mock.calls[0] as [string];
      expect(method).toBe('GET');
    });

    it('accepts DELETE method', async () => {
      await apiCommand(mockAuth, 'delete', '/api/item/123', {});

      const [method] = apiRequestSpy.mock.calls[0] as [string];
      expect(method).toBe('DELETE');
    });
  });

  describe('template substitution', () => {
    it('substitutes {organization} from auth', async () => {
      await apiCommand(mockAuth, 'get', '/api/issues/search?organization={organization}', {});

      const [, url] = apiRequestSpy.mock.calls[0] as [string, string];
      expect(url).toContain('organization=my-org');
    });

    it('substitutes {project} from discovered project', async () => {
      await apiCommand(mockAuth, 'get', '/api/issues/search?project={project}', {});

      const [, url] = apiRequestSpy.mock.calls[0] as [string, string];
      expect(url).toContain('project=my-project');
    });

    it('passes through endpoint with no templates', async () => {
      await apiCommand(mockAuth, 'get', '/api/system/status', {});

      const [, url] = apiRequestSpy.mock.calls[0] as [string, string];
      expect(url).toBe('https://sonar.example.com/api/system/status');
    });
  });

  describe('error responses', () => {
    it('prints body and throws on non-2xx response', async () => {
      apiRequestSpy.mockResolvedValue(
        makeApiResponse({
          status: 401,
          statusText: 'Unauthorized',
          body: '{"errors":[{"msg":"Unauthorized"}]}',
        }),
      );

      try {
        await apiCommand(mockAuth, 'get', '/api/test', {});
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expect((err as Error).message).toBe('HTTP 401 Unauthorized');
      }

      const printCalls = getMockUiCalls().filter((c) => c.method === 'print');
      expect(printCalls).toHaveLength(1);
      expect(printCalls[0].args[0]).toBe('{"errors":[{"msg":"Unauthorized"}]}');
    });

    it('does not print when body is empty on error', async () => {
      apiRequestSpy.mockResolvedValue(
        makeApiResponse({
          status: 404,
          statusText: 'Not Found',
          body: '',
        }),
      );

      try {
        await apiCommand(mockAuth, 'get', '/api/missing', {});
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expect((err as Error).message).toBe('HTTP 404 Not Found');
      }

      const printCalls = getMockUiCalls().filter((c) => c.method === 'print');
      expect(printCalls).toHaveLength(0);
    });
  });

  describe('project discovery failure', () => {
    it('works without project template when discovery fails', async () => {
      discoverProjectSpy.mockRejectedValue(new Error('no git root'));

      await apiCommand(mockAuth, 'get', '/api/system/status', {});

      const [, url] = apiRequestSpy.mock.calls[0] as [string, string];
      expect(url).toBe('https://sonar.example.com/api/system/status');
    });

    it('fails if project template is used but discovery fails', () => {
      discoverProjectSpy.mockRejectedValue(new Error('no git root'));

      expect(
        apiCommand(mockAuth, 'get', '/api/issues/search?project={project}', {}),
      ).rejects.toThrow('Unknown template variable {project}');
    });
  });

  describe('content type detection', () => {
    it('uses form encoding for v1 API endpoints', async () => {
      const data = '{"name":"test-token"}';
      await apiCommand(mockAuth, 'post', '/api/user_tokens/generate', { data });

      const [, , , , contentType] = apiRequestSpy.mock.calls[0] as [
        string,
        string,
        string,
        string,
        string,
      ];
      expect(contentType).toBe('form');
    });

    it('uses JSON encoding for v2 API endpoints', async () => {
      const data = '{"name":"test"}';
      await apiCommand(mockAuth, 'post', '/api/v2/dop-translation/bound-projects', { data });

      const [, , , , contentType] = apiRequestSpy.mock.calls[0] as [
        string,
        string,
        string,
        string,
        string,
      ];
      expect(contentType).toBe('json');
    });

    it('does not pass data for GET requests regardless of endpoint version', async () => {
      await apiCommand(mockAuth, 'get', '/api/system/status', {});

      const [, , , body] = apiRequestSpy.mock.calls[0] as [
        string,
        string,
        string,
        string | undefined,
      ];
      expect(body).toBeUndefined();
    });
  });

  describe('SonarCloud URL routing', () => {
    const cloudAuth: ResolvedAuth = {
      token: 'test-token',
      serverUrl: 'https://sonarcloud.io',
      orgKey: 'my-org',
      connectionType: 'cloud',
    };

    it('uses sonarcloud.io for /api endpoints on SonarCloud', async () => {
      await apiCommand(cloudAuth, 'get', '/api/issues/search', {});

      const [, url] = apiRequestSpy.mock.calls[0] as [string, string];
      expect(url).toBe('https://sonarcloud.io/api/issues/search');
    });

    it('uses api.sonarcloud.io for non-/api endpoints on SonarCloud', async () => {
      await apiCommand(cloudAuth, 'get', '/monitoring/metrics', {});

      const [, url] = apiRequestSpy.mock.calls[0] as [string, string];
      expect(url).toBe('https://api.sonarcloud.io/monitoring/metrics');
    });

    it('does not reroute non-SonarCloud servers', async () => {
      await apiCommand(mockAuth, 'get', '/monitoring/metrics', {});

      const [, url] = apiRequestSpy.mock.calls[0] as [string, string];
      expect(url).toBe('https://sonar.example.com/monitoring/metrics');
    });
  });

  describe('trailing slash handling', () => {
    it('strips trailing slash from server URL', async () => {
      const authWithSlash: ResolvedAuth = {
        token: 'test-token',
        serverUrl: 'https://sonar.example.com/',
        orgKey: undefined,
        connectionType: 'on-premise',
      };

      await apiCommand(authWithSlash, 'get', '/api/system/status', {});

      const [, url] = apiRequestSpy.mock.calls[0] as [string, string];
      expect(url).toBe('https://sonar.example.com/api/system/status');
    });
  });
});

describe('resolveBaseUrl', () => {
  it('returns sonarcloud.io for /api endpoints on SonarCloud', () => {
    expect(resolveBaseUrl('https://sonarcloud.io', '/api/issues/search')).toBe(
      'https://sonarcloud.io',
    );
  });

  it('returns api.sonarcloud.io for non-/api endpoints on SonarCloud', () => {
    expect(resolveBaseUrl('https://sonarcloud.io', '/monitoring/metrics')).toBe(
      'https://api.sonarcloud.io',
    );
  });

  it('returns sonarcloud.io for /api/v2 endpoints on SonarCloud', () => {
    expect(resolveBaseUrl('https://sonarcloud.io', '/api/v2/projects')).toBe(
      'https://sonarcloud.io',
    );
  });

  it('strips trailing slash for non-SonarCloud servers', () => {
    expect(resolveBaseUrl('https://mysonar.example.com/', '/api/test')).toBe(
      'https://mysonar.example.com',
    );
  });

  it('returns server URL as-is for non-SonarCloud servers', () => {
    expect(resolveBaseUrl('https://mysonar.example.com', '/monitoring/metrics')).toBe(
      'https://mysonar.example.com',
    );
  });
});

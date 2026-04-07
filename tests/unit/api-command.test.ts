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
import type { ResolvedAuth } from '../../src/lib/auth-resolver.js';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import { apiCommand } from '../../src/cli/commands/api/api.js';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../src/ui';

const TEST_SERVER = 'https://sonar.example.com';
const TEST_ORG = 'test-org';

const FAKE_AUTH: ResolvedAuth = {
  token: 'squ_test_token',
  serverUrl: TEST_SERVER,
  orgKey: TEST_ORG,
  connectionType: 'on-premise',
};

let genericRequestSpy: ReturnType<typeof spyOn>;

describe('apiCommand', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();

    genericRequestSpy = spyOn(SonarQubeClient.prototype, 'genericRequest').mockResolvedValue(
      '{"status":"UP"}',
    );
  });

  afterEach(() => {
    setMockUi(false);
    genericRequestSpy.mockRestore();
  });

  it('throws InvalidOptionError for invalid HTTP method', () => {
    expect(apiCommand(FAKE_AUTH, 'TRACE', '/api/system/status', {})).rejects.toThrow(
      "Invalid HTTP method 'TRACE'",
    );
  });

  it('throws InvalidOptionError when endpoint does not start with /', () => {
    expect(apiCommand(FAKE_AUTH, 'get', 'api/system/status', {})).rejects.toThrow(
      "Endpoint must start with '/'",
    );
  });

  it('throws InvalidOptionError when --data is used with GET', () => {
    expect(
      apiCommand(FAKE_AUTH, 'get', '/api/system/status', { data: '{"k":"v"}' }),
    ).rejects.toThrow('--data is only valid for');
  });

  it('throws InvalidOptionError when --data is used with DELETE', () => {
    expect(
      apiCommand(FAKE_AUTH, 'delete', '/api/system/status', { data: '{"k":"v"}' }),
    ).rejects.toThrow('--data is only valid for');
  });

  it('throws InvalidOptionError when --data is not valid JSON', () => {
    expect(
      apiCommand(FAKE_AUTH, 'post', '/api/system/status', { data: 'not-json' }),
    ).rejects.toThrow('--data must be valid JSON');
  });

  it('makes a GET request and prints the response', async () => {
    await apiCommand(FAKE_AUTH, 'get', '/api/system/status', {});

    expect(genericRequestSpy).toHaveBeenCalledTimes(1);
    const [method, endpoint, data, contentType] = genericRequestSpy.mock.calls[0];
    expect(method).toBe('GET');
    expect(endpoint).toBe('/api/system/status');
    expect(data).toBeUndefined();
    expect(contentType).toBe('form');

    const output = getMockUiCalls().filter((c) => c.method === 'print');
    expect(output.some((c) => String(c.args[0]).includes('UP'))).toBe(true);
  });

  it('uppercases the method', async () => {
    await apiCommand(FAKE_AUTH, 'post', '/api/system/status', { data: '{"k":"v"}' });

    const [method] = genericRequestSpy.mock.calls[0];
    expect(method).toBe('POST');
  });

  it('sends POST request with --data body', async () => {
    const body = '{"key":"value"}';
    await apiCommand(FAKE_AUTH, 'post', '/api/issues/search', { data: body });

    const [, , data] = genericRequestSpy.mock.calls[0];
    expect(data).toBe(body);
  });

  it('uses json content type for /api/v2/ endpoints', async () => {
    await apiCommand(FAKE_AUTH, 'get', '/api/v2/issues/search', {});

    const [, , , contentType] = genericRequestSpy.mock.calls[0];
    expect(contentType).toBe('json');
  });

  it('uses form content type for /api/ endpoints', async () => {
    await apiCommand(FAKE_AUTH, 'get', '/api/issues/search', {});

    const [, , , contentType] = genericRequestSpy.mock.calls[0];
    expect(contentType).toBe('form');
  });

  it('makes a DELETE request without data', async () => {
    await apiCommand(FAKE_AUTH, 'delete', '/api/authentication/validate', {});

    expect(genericRequestSpy).toHaveBeenCalledTimes(1);
    const [method, , data] = genericRequestSpy.mock.calls[0];
    expect(method).toBe('DELETE');
    expect(data).toBeUndefined();
  });

  it('passes the endpoint to genericRequest', async () => {
    await apiCommand(FAKE_AUTH, 'get', '/api/system/status', {});

    const [, endpoint] = genericRequestSpy.mock.calls[0];
    expect(endpoint).toBe('/api/system/status');
  });

  it('passes valid JSON data through to genericRequest for PUT', async () => {
    const body = '{"key":"val"}';
    await apiCommand(FAKE_AUTH, 'put', '/api/v2/settings/set', { data: body });

    const [method, , data, contentType] = genericRequestSpy.mock.calls[0];
    expect(method).toBe('PUT');
    expect(data).toBe(body);
    expect(contentType).toBe('json');
  });
});

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

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { apiRequest } from '../../src/lib/api-request.js';

describe('apiRequest', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  function mockFetch(status: number, body: string, statusText = 'OK') {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status, statusText }),
    );
  }

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('sends GET request with correct URL and auth header', async () => {
    mockFetch(200, '{"status":"UP"}');

    await apiRequest('GET', 'https://sonar.example.com/api/system/status', 'my-token');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sonar.example.com/api/system/status');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer my-token');
  });

  it('includes User-Agent header', async () => {
    mockFetch(200, '{}');

    await apiRequest('GET', 'https://sonar.example.com/api/test', 'tok');

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/^sonarqube-cli\//);
  });

  it('includes Accept: application/json', async () => {
    mockFetch(200, '{}');

    await apiRequest('GET', 'https://sonar.example.com/api/test', 'tok');

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
  });

  it('sends POST with body and Content-Type', async () => {
    mockFetch(200, '{"ok":true}');

    const data = '{"name":"test"}';
    await apiRequest('POST', 'https://sonar.example.com/api/create', 'tok', data);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(data);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('sends PATCH with body and Content-Type', async () => {
    mockFetch(200, '{"ok":true}');

    const data = '{"name":"updated"}';
    await apiRequest('PATCH', 'https://sonar.example.com/api/update', 'tok', data);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(data);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('sends DELETE without body', async () => {
    mockFetch(204, '');

    await apiRequest('DELETE', 'https://sonar.example.com/api/item/123', 'tok');

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('returns status, statusText, body, and headers on success', async () => {
    mockFetch(200, '{"result":"ok"}');

    const response = await apiRequest('GET', 'https://sonar.example.com/api/test', 'tok');

    expect(response.status).toBe(200);
    expect(response.body).toBe('{"result":"ok"}');
    expect(response.headers).toBeInstanceOf(Headers);
  });

  it('returns non-2xx responses without throwing', async () => {
    mockFetch(401, '{"errors":[{"msg":"Unauthorized"}]}', 'Unauthorized');

    const response = await apiRequest('GET', 'https://sonar.example.com/api/test', 'bad-token');

    expect(response.status).toBe(401);
    expect(response.statusText).toBe('Unauthorized');
    expect(response.body).toBe('{"errors":[{"msg":"Unauthorized"}]}');
  });

  it('does not include Content-Type for GET', async () => {
    mockFetch(200, '{}');

    await apiRequest('GET', 'https://sonar.example.com/api/test', 'tok', '{"ignored":true}');

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('sends POST with form-encoded body when contentType is form', async () => {
    mockFetch(200, '{"ok":true}');

    const data = '{"name":"test","login":"admin"}';
    await apiRequest('POST', 'https://sonar.example.com/api/create', 'tok', data, 'form');

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(init.body).toBe('name=test&login=admin');
  });

  it('sends POST with JSON body by default', async () => {
    mockFetch(200, '{"ok":true}');

    const data = '{"name":"test"}';
    await apiRequest('POST', 'https://sonar.example.com/api/create', 'tok', data);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(data);
  });

  it('form-encodes string, number, and boolean values', async () => {
    mockFetch(200, '{}');

    const data = '{"name":"tok","days":30,"permanent":false}';
    await apiRequest('POST', 'https://sonar.example.com/api/tokens', 'tok', data, 'form');

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('name=tok&days=30&permanent=false');
  });

  it('sends PATCH with form-encoded body when contentType is form', async () => {
    mockFetch(200, '{"ok":true}');

    const data = '{"name":"updated"}';
    await apiRequest('PATCH', 'https://sonar.example.com/api/update', 'tok', data, 'form');

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(init.body).toBe('name=updated');
  });
});

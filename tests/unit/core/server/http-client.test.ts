/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
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

import { SONARCLOUD_API_URL, SONARCLOUD_URL } from '@/core/config-constants.ts';
import { unwrap } from '@/core/result.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '@/core/ui';

import { version as VERSION } from '../../../../package.json';
import { lastFetchInit, lastFetchUrl, mockFetch } from '../../helpers/mock-fetch.ts';

const SERVER_URL = 'https://sonarqube.example.com';
const TOKEN = 'squ_test_token';

describe('SonarHttpClient', () => {
  let client: SonarHttpClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new SonarHttpClient(SERVER_URL, TOKEN);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('get', () => {
    it('uses serverURL as base by default', async () => {
      fetchSpy = mockFetch({ valid: true });
      await client.get('/api/authentication/validate');
      expect(lastFetchUrl(fetchSpy)).toBe(`${SERVER_URL}/api/authentication/validate`);
    });

    it('strips trailing slash from serverURL', async () => {
      const clientWithSlash = new SonarHttpClient(`${SERVER_URL}/`, TOKEN);
      fetchSpy = mockFetch({ valid: true });
      await clientWithSlash.get('/api/authentication/validate');
      expect(lastFetchUrl(fetchSpy)).toBe(`${SERVER_URL}/api/authentication/validate`);
    });

    it('appends query parameters to the URL', async () => {
      fetchSpy = mockFetch({ organizations: [] });
      await client.get('/api/organizations/search', {
        organizations: 'my-org',
        ps: 1,
        active: true,
      });
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.searchParams.get('organizations')).toBe('my-org');
      expect(url.searchParams.get('ps')).toBe('1');
      expect(url.searchParams.get('active')).toBe('true');
    });

    it('sends Bearer authorization header', async () => {
      fetchSpy = mockFetch({});
      await client.get('/api/authentication/validate');
      expect(lastFetchInit(fetchSpy).headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
      });
    });

    it('sends User-Agent header with CLI version', async () => {
      fetchSpy = mockFetch({});
      await client.get('/api/authentication/validate');
      expect(lastFetchInit(fetchSpy).headers).toMatchObject({
        'User-Agent': `sonarqube-cli/${VERSION}`,
      });
    });

    it('uses the provided baseUrl instead of serverURL', async () => {
      fetchSpy = mockFetch({ id: 'org-uuid' });
      await client.get('/organizations', { organizationKey: 'my-org' }, SONARCLOUD_API_URL);
      expect(lastFetchUrl(fetchSpy)).toBe(
        `${SONARCLOUD_API_URL}/organizations?organizationKey=my-org`,
      );
    });

    it('returns an error result when response is not ok', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 401 });
      const result = await client.get('/api/authentication/validate');
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: Error }).error.message).toBe(
        'SonarQube API error: 401 Internal Server Error',
      );
    });
  });

  describe('bearer token not forwarded on redirect', () => {
    it('get uses redirect: manual so the runtime cannot auto-follow', async () => {
      fetchSpy = mockFetch({});
      await client.get('/api/endpoint');
      expect(lastFetchInit(fetchSpy).redirect).toBe('manual');
    });

    it('post uses redirect: manual so the runtime cannot auto-follow', async () => {
      fetchSpy = mockFetch({});
      await client.post('/api/endpoint', {});
      expect(lastFetchInit(fetchSpy).redirect).toBe('manual');
    });

    it('postForm uses redirect: manual so the runtime cannot auto-follow', async () => {
      fetchSpy = mockFetch({}, { status: 204 });
      await client.postForm('/api/endpoint', { k: 'v' });
      expect(lastFetchInit(fetchSpy).redirect).toBe('manual');
    });

    it('follows a same-origin 302 redirect transparently', async () => {
      // Scenario: server redirects /api/v1/endpoint → /api/v2/endpoint (same origin)
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          headers: new Headers({ location: `${SERVER_URL}/api/v2/endpoint` }),
          text: () => Promise.resolve(''),
          json: () => Promise.resolve({}),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.resolve({ valid: true }),
          text: () => Promise.resolve('{"valid":true}'),
        } as unknown as Response);

      const result = await client.get<{ valid: boolean }>('/api/v1/endpoint');
      expect(result.ok).toBe(true);
      expect((result as { ok: true; value: { valid: boolean } }).value.valid).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[1][0] as string).toContain('/api/v2/endpoint');
    });

    it('rejects a cross-origin 302 redirect without forwarding the bearer token', async () => {
      // Vulnerability: without fetchAuthenticated, Authorization would be sent to attacker.com
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 302,
        headers: new Headers({ location: 'https://attacker.com/steal' }),
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({}),
      } as unknown as Response);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.get('/api/endpoint')).rejects.toThrow('cross-origin redirect');

      // fetch was called exactly once — the token was never sent to attacker.com
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0] as string).toContain(SERVER_URL);
    });
  });

  describe('getSafe', () => {
    it('returns response and parsed value on success', async () => {
      fetchSpy = mockFetch({ valid: true });
      const result = await client.getSafe<{ valid: boolean }>('/api/authentication/validate');
      expect(result.response.ok).toBe(true);
      expect(result.value).toEqual({ valid: true });
    });

    it('returns response with undefined value on non-ok status (does not throw)', async () => {
      fetchSpy = mockFetch({ errors: [{ msg: 'Not found' }] }, { ok: false, status: 404 });
      const result = await client.getSafe('/api/settings/values', { component: 'missing' });
      expect(result.response.ok).toBe(false);
      expect(result.response.status).toBe(404);
      expect(result.value).toBeUndefined();
    });

    it('appends query parameters to the URL', async () => {
      fetchSpy = mockFetch({});
      await client.getSafe('/api/settings/values', { component: 'demo' });
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.searchParams.get('component')).toBe('demo');
    });

    it('uses provided baseUrl instead of serverURL', async () => {
      fetchSpy = mockFetch({});
      await client.getSafe('/foo', undefined, SONARCLOUD_API_URL);
      expect(lastFetchUrl(fetchSpy)).toBe(`${SONARCLOUD_API_URL}/foo`);
    });
  });

  describe('post', () => {
    it('sends POST with JSON body', async () => {
      fetchSpy = mockFetch({ result: 'ok' });
      await client.post('/api/some/endpoint', { key: 'value' });
      const init = lastFetchInit(fetchSpy);
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ key: 'value' }));
    });

    it('sets Content-Type: application/json', async () => {
      fetchSpy = mockFetch({});
      await client.post('/api/some/endpoint', {});
      expect(lastFetchInit(fetchSpy).headers).toMatchObject({
        'Content-Type': 'application/json',
      });
    });

    it('returns an error result with the response body text when response is not ok', async () => {
      fetchSpy = mockFetch({ message: 'Not found' }, { ok: false, status: 404 });
      const result = await client.post('/api/some/endpoint', {});
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: Error }).error.message).toContain('404');
    });
  });

  describe('postForm', () => {
    it('sends a form-encoded POST with URL-encoded body', async () => {
      fetchSpy = mockFetch({}, { status: 204 });
      await client.postForm('/api/some/form', { foo: 'bar baz', qux: 'a&b' });
      const init = lastFetchInit(fetchSpy);
      expect(init.method).toBe('POST');
      expect(init.body).toBe('foo=bar+baz&qux=a%26b');
    });

    it('sets Content-Type: application/x-www-form-urlencoded and Bearer auth', async () => {
      fetchSpy = mockFetch({}, { status: 204 });
      await client.postForm('/api/some/form', { name: 'test' });
      expect(lastFetchInit(fetchSpy).headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${TOKEN}`,
      });
    });

    it('targets the exact endpoint on the configured server URL', async () => {
      fetchSpy = mockFetch({}, { status: 204 });
      await client.postForm('/api/some/form', { name: 'test' });
      expect(lastFetchUrl(fetchSpy)).toBe(`${SERVER_URL}/api/some/form`);
    });

    it('returns an error result with the response body text when response is not ok', async () => {
      fetchSpy = mockFetch({ message: 'boom' }, { ok: false, status: 500 });
      const result = await client.postForm('/api/some/form', { name: 'test' });
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: Error }).error.message).toBe(
        'SonarQube API error: 500 Internal Server Error - {"message":"boom"}',
      );
    });
  });

  describe('genericRequest', () => {
    beforeEach(() => {
      setMockUi(true);
      clearMockUiCalls();
    });

    afterEach(() => {
      setMockUi(false);
    });

    it('makes a GET request and returns response text', async () => {
      fetchSpy = mockFetch({ status: 'UP' });
      const result = unwrap(await client.genericRequest('GET', '/api/system/status'));
      expect(result).toBe('{"status":"UP"}');

      const url = (fetchSpy.mock.calls[0][0] as string).toString();
      expect(url).toBe(`${SERVER_URL}/api/system/status`);

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
    });

    it('sends POST with JSON body when contentType is json', async () => {
      fetchSpy = mockFetch({ ok: true });
      const data = '{"key":"value"}';
      await client.genericRequest('POST', '/api/v2/issues', data, 'json');

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('POST');
      expect(init.body).toBe(data);
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    it('sends POST with form-encoded body when contentType is form', async () => {
      fetchSpy = mockFetch({ ok: true });
      const data = '{"component":"my-project","severity":"MAJOR"}';
      await client.genericRequest('POST', '/api/issues/do_transition', data, 'form');

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.body).toBe('component=my-project&severity=MAJOR');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );
    });

    it('sends PATCH with JSON body', async () => {
      fetchSpy = mockFetch({ ok: true });
      const data = '{"name":"updated"}';
      await client.genericRequest('PATCH', '/api/v2/projects', data, 'json');

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('PATCH');
      expect(init.body).toBe(data);
    });

    it('sends PUT with JSON body', async () => {
      fetchSpy = mockFetch({ ok: true });
      await client.genericRequest('PUT', '/api/v2/settings', '{"k":"v"}', 'json');

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('PUT');
      expect(init.body).toBe('{"k":"v"}');
    });

    it('does not send body for DELETE', async () => {
      fetchSpy = mockFetch({ ok: true });
      await client.genericRequest('DELETE', '/api/v2/tokens/revoke');

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe('DELETE');
      expect(init.body).toBeUndefined();
    });

    it('prints debug output when debug is true', async () => {
      fetchSpy = mockFetch({ status: 'UP' });
      await client.genericRequest('GET', '/api/system/status', undefined, 'json', true);

      const output = getMockUiCalls().filter((c) => c.method === 'print');
      const messages = output.map((c) => String(c.args[0]));
      expect(messages.some((m) => m.includes('request method: GET'))).toBe(true);
      expect(messages.some((m) => m.includes('request url:'))).toBe(true);
      expect(messages.some((m) => m.includes('response status:'))).toBe(true);
    });

    it('does not print debug output when debug is false', async () => {
      fetchSpy = mockFetch({ status: 'UP' });
      await client.genericRequest('GET', '/api/system/status');

      const output = getMockUiCalls().filter((c) => c.method === 'print');
      const messages = output.map((c) => String(c.args[0]));
      expect(messages.some((m) => m.includes('request method:'))).toBe(false);
    });

    it('returns a BadRequestError result on non-ok POST response', async () => {
      fetchSpy = mockFetch({ message: 'Bad request' }, { ok: false, status: 400 });
      const result = await client.genericRequest(
        'POST',
        '/api/issues/do_transition',
        '{"k":"v"}',
        'form',
      );
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: Error }).error).toMatchObject({
        name: 'BadRequestError',
        message: 'Bad request',
      });
    });

    it('preserves raw body for non-SQAA POST 400 responses', async () => {
      fetchSpy = mockFetch({ errors: [{ msg: 'Transition failed' }] }, { ok: false, status: 400 });
      const result = await client.genericRequest(
        'POST',
        '/api/issues/do_transition',
        '{"k":"v"}',
        'form',
      );
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: Error }).error).toMatchObject({
        name: 'BadRequestError',
        message: expect.stringContaining('Transition failed'),
      });
    });

    it('returns an access-denied error result on GET 403', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 403 });
      const result = await client.genericRequest('GET', '/api/system/status');
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: Error }).error.message).toContain('Access denied');
    });

    it('resolves a plain SonarCloud /api endpoint correctly', async () => {
      const cloudClient = new SonarHttpClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch({ ok: true });
      await cloudClient.genericRequest('GET', '/api/issues/search');

      const url = (fetchSpy.mock.calls[0][0] as string).toString();
      expect(url).toBe(`${SONARCLOUD_URL}/api/issues/search`);
    });

    it('strips the /api/v2 prefix and routes to the API host on SonarCloud', async () => {
      const cloudClient = new SonarHttpClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch({ ok: true });
      await cloudClient.genericRequest('GET', '/api/v2/sca/issues-releases');

      const url = (fetchSpy.mock.calls[0][0] as string).toString();
      expect(url).toBe(`${SONARCLOUD_API_URL}/sca/issues-releases`);
    });
  });
});

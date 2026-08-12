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

import {
  SONARCLOUD_API_URL,
  SONARCLOUD_URL,
  SONARCLOUD_US_API_URL,
  SONARCLOUD_US_URL,
} from '@/core/config-constants.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import { ForbiddenApiError } from '@/core/server/errors.ts';
import { fetchGuarded } from '@/core/server/fetch-guarded.ts';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '@/core/ui';

import { version as VERSION } from '../../../../package.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(body: unknown, ok = true, status = 200): ReturnType<typeof spyOn> {
  const statusText = ok ? 'OK' : 'Internal Server Error';
  return spyOn(globalThis, 'fetch').mockResolvedValue({
    ok,
    status,
    statusText,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function lastFetchUrl(fetchSpy: ReturnType<typeof spyOn>): string {
  return (fetchSpy.mock.calls[0][0] as URL).toString();
}

function lastFetchInit(fetchSpy: ReturnType<typeof spyOn>): RequestInit {
  return fetchSpy.mock.calls[0][1] as RequestInit;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SERVER_URL = 'https://sonarqube.example.com';
const TOKEN = 'squ_test_token';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SonarQubeClient', () => {
  let client: SonarQubeClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new SonarQubeClient(SERVER_URL, TOKEN);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  // -------------------------------------------------------------------------
  // get — shared request behaviour
  // -------------------------------------------------------------------------

  describe('get', () => {
    it('uses serverURL as base by default', async () => {
      fetchSpy = mockFetch({ valid: true });
      await client.get('/api/authentication/validate');
      expect(lastFetchUrl(fetchSpy)).toBe(`${SERVER_URL}/api/authentication/validate`);
    });

    it('strips trailing slash from serverURL', async () => {
      const clientWithSlash = new SonarQubeClient(`${SERVER_URL}/`, TOKEN);
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

    it('throws when response is not ok', async () => {
      fetchSpy = mockFetch({}, false, 401);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.get('/api/authentication/validate')).rejects.toThrow(
        'SonarQube API error: 401',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Bearer token must not be forwarded to cross-origin redirect targets (F9)
  //
  // fetchGuarded() intercepts every 3xx before the runtime follows it:
  // - same-origin redirects are followed transparently (e.g. HTTP→HTTPS)
  // - cross-origin redirects throw so the Authorization header is never
  //   forwarded to an attacker-controlled domain
  //
  // RED without the fix (redirect: 'follow' sends auth to all destinations)
  // GREEN with it.
  // -------------------------------------------------------------------------

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
      fetchSpy = mockFetch({}, true, 204);
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
      expect(result.valid).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[1][0] as string).toContain('/api/v2/endpoint');
    });

    it('rejects a cross-origin 302 redirect without forwarding the bearer token', async () => {
      // Vulnerability: without fetchGuarded, Authorization would be sent to attacker.com
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

  // -------------------------------------------------------------------------
  // fetchGuarded — standalone redirect guard
  // -------------------------------------------------------------------------

  describe('fetchGuarded', () => {
    it('follows a same-origin redirect and returns the final response', async () => {
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: false,
          status: 301,
          headers: new Headers({ location: `${SERVER_URL}/new-path` }),
          text: () => Promise.resolve(''),
          json: () => Promise.resolve({}),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.resolve({ data: 'ok' }),
          text: () => Promise.resolve('{"data":"ok"}'),
        } as unknown as Response);

      const res = await fetchGuarded(`${SERVER_URL}/old-path`, {});
      expect(res.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('throws on cross-origin redirect before making a second request', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 302,
        headers: new Headers({ location: 'https://evil.com/capture' }),
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({}),
      } as unknown as Response);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(fetchGuarded(`${SERVER_URL}/api`, {})).rejects.toThrow('cross-origin redirect');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('follows an HTTP→HTTPS upgrade redirect on the same hostname', async () => {
      const httpUrl = 'http://sonarqube.example.com/api/endpoint';
      const httpsUrl = 'https://sonarqube.example.com/api/endpoint';
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: false,
          status: 301,
          headers: new Headers({ location: httpsUrl }),
          text: () => Promise.resolve(''),
          json: () => Promise.resolve({}),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.resolve({ ok: true }),
          text: () => Promise.resolve('{"ok":true}'),
        } as unknown as Response);

      const res = await fetchGuarded(httpUrl, {});
      expect(res.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[1][0] as string).toBe(httpsUrl);
    });

    it('returns 304 as-is without throwing (no Location header expected)', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 304,
        headers: new Headers(),
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({}),
      } as unknown as Response);

      const res = await fetchGuarded(`${SERVER_URL}/api`, {});
      expect(res.status).toBe(304);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('downgrades POST to GET on 301/302/303 redirect (drops body)', async () => {
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          headers: new Headers({ location: `${SERVER_URL}/new-endpoint` }),
          text: () => Promise.resolve(''),
          json: () => Promise.resolve({}),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('{}'),
        } as unknown as Response);

      await fetchGuarded(`${SERVER_URL}/api`, { method: 'POST', body: '{"key":"val"}' });

      const secondInit = fetchSpy.mock.calls[1][1] as RequestInit;
      expect(secondInit.method).toBe('GET');
      expect(secondInit.body).toBeUndefined();
    });

    it('strips Content-Type header when downgrading POST to GET on 301/302/303', async () => {
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          headers: new Headers({ location: `${SERVER_URL}/new-endpoint` }),
          text: () => Promise.resolve(''),
          json: () => Promise.resolve({}),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('{}'),
        } as unknown as Response);

      await fetchGuarded(`${SERVER_URL}/api`, {
        method: 'POST',
        body: '{"key":"val"}',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      });

      const secondInit = fetchSpy.mock.calls[1][1] as RequestInit;
      const headers = secondInit.headers as Record<string, string>;
      expect(headers['Content-Type']).toBeUndefined();
      // Authorization is preserved — token still goes to the (same-origin) redirect target
      expect(headers['Authorization']).toBe('Bearer tok');
    });

    it('preserves POST body on 307/308 redirect', async () => {
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: false,
          status: 307,
          headers: new Headers({ location: `${SERVER_URL}/new-endpoint` }),
          text: () => Promise.resolve(''),
          json: () => Promise.resolve({}),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('{}'),
        } as unknown as Response);

      await fetchGuarded(`${SERVER_URL}/api`, { method: 'POST', body: '{"key":"val"}' });

      const secondInit = fetchSpy.mock.calls[1][1] as RequestInit;
      expect(secondInit.method).toBe('POST');
      expect(secondInit.body).toBe('{"key":"val"}');
    });

    it('throws after too many same-origin redirects', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 302,
        headers: new Headers({ location: `${SERVER_URL}/loop` }),
        text: () => Promise.resolve(''),
        json: () => Promise.resolve({}),
      } as unknown as Response);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(fetchGuarded(`${SERVER_URL}/loop`, {})).rejects.toThrow('too many redirects');
    });
  });

  // -------------------------------------------------------------------------
  // getSafe — non-throwing variant returns response + value
  // -------------------------------------------------------------------------

  describe('getSafe', () => {
    it('returns response and parsed value on success', async () => {
      fetchSpy = mockFetch({ valid: true });
      const result = await client.getSafe<{ valid: boolean }>('/api/authentication/validate');
      expect(result.response.ok).toBe(true);
      expect(result.value).toEqual({ valid: true });
    });

    it('returns response with undefined value on non-ok status (does not throw)', async () => {
      fetchSpy = mockFetch({ errors: [{ msg: 'Not found' }] }, false, 404);
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

  // -------------------------------------------------------------------------
  // getProjectSettings
  // -------------------------------------------------------------------------

  describe('getProjectSettings', () => {
    it('returns the settings array on success', async () => {
      const settings = [
        { key: 'sonar.exclusions', values: ['**/test/**'], inherited: false },
        { key: 'sonar.sca.foo', value: 'bar', inherited: false },
      ];
      fetchSpy = mockFetch({ settings });
      expect(await client.getProjectSettings('demo')).toEqual(settings);
    });

    it('returns an empty array when the API omits settings', async () => {
      fetchSpy = mockFetch({});
      expect(await client.getProjectSettings('demo')).toEqual([]);
    });

    it('passes the project key as the component query param', async () => {
      fetchSpy = mockFetch({ settings: [] });
      await client.getProjectSettings('demo');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/settings/values');
      expect(url.searchParams.get('component')).toBe('demo');
    });

    it('throws "Project ... not found" on 404', async () => {
      fetchSpy = mockFetch({ errors: [{ msg: 'Not found' }] }, false, 404);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.getProjectSettings('missing')).rejects.toThrow(
        "Project 'missing' not found",
      );
    });

    it('throws a generic API error on other non-ok statuses', async () => {
      fetchSpy = mockFetch({}, false, 500);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.getProjectSettings('demo')).rejects.toThrow('SonarQube API error: 500');
    });
  });

  // -------------------------------------------------------------------------
  // post — shared request behaviour
  // -------------------------------------------------------------------------

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

    it('throws with error body text when response is not ok', async () => {
      fetchSpy = mockFetch({ message: 'Not found' }, false, 404);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.post('/api/some/endpoint', {})).rejects.toThrow('404');
    });
  });

  // -------------------------------------------------------------------------
  // postForm + revokeUserToken
  // -------------------------------------------------------------------------

  describe('postForm', () => {
    it('sends a form-encoded POST with URL-encoded body', async () => {
      fetchSpy = mockFetch({}, true, 204);
      await client.postForm('/api/some/form', { foo: 'bar baz', qux: 'a&b' });
      const init = lastFetchInit(fetchSpy);
      expect(init.method).toBe('POST');
      expect(init.body).toBe('foo=bar+baz&qux=a%26b');
    });

    it('sets Content-Type: application/x-www-form-urlencoded and Bearer auth', async () => {
      fetchSpy = mockFetch({}, true, 204);
      await client.postForm('/api/some/form', { name: 'test' });
      expect(lastFetchInit(fetchSpy).headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${TOKEN}`,
      });
    });

    it('targets the exact endpoint on the configured server URL', async () => {
      fetchSpy = mockFetch({}, true, 204);
      await client.postForm('/api/some/form', { name: 'test' });
      expect(lastFetchUrl(fetchSpy)).toBe(`${SERVER_URL}/api/some/form`);
    });

    it('throws with error body text when response is not ok', async () => {
      fetchSpy = mockFetch({ message: 'boom' }, false, 500);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.postForm('/api/some/form', { name: 'test' })).rejects.toThrow(
        'SonarQube API error: 500 Internal Server Error',
      );
    });
  });

  describe('revokeUserToken', () => {
    it('POSTs name=<tokenName> to /api/user_tokens/revoke', async () => {
      fetchSpy = mockFetch({}, true, 204);
      await client.revokeUserToken('cli-token-name');
      expect(lastFetchUrl(fetchSpy)).toBe(`${SERVER_URL}/api/user_tokens/revoke`);
      const init = lastFetchInit(fetchSpy);
      expect(init.method).toBe('POST');
      expect(init.body).toBe('name=cli-token-name');
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${TOKEN}`,
      });
    });

    it('URL-encodes special characters in the token name', async () => {
      fetchSpy = mockFetch({}, true, 204);
      await client.revokeUserToken('cli token+with/special&chars');
      expect(lastFetchInit(fetchSpy).body).toBe('name=cli+token%2Bwith%2Fspecial%26chars');
    });

    it('propagates server errors to the caller', async () => {
      fetchSpy = mockFetch('revocation boom', false, 500);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.revokeUserToken('cli-token-name')).rejects.toThrow(
        'SonarQube API error: 500 Internal Server Error',
      );
    });
  });

  // -------------------------------------------------------------------------
  // checkTokenValidity
  // -------------------------------------------------------------------------

  describe('checkTokenValidity', () => {
    it("returns 'valid' when API reports the token as valid", async () => {
      fetchSpy = mockFetch({ valid: true });
      expect(await client.checkTokenValidity()).toBe('valid');
    });

    it("returns 'invalid' when API reports the token as invalid", async () => {
      fetchSpy = mockFetch({ valid: false });
      expect(await client.checkTokenValidity()).toBe('invalid');
    });

    it('throws on network / API error', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
      await expect(client.checkTokenValidity()).rejects.toThrow('Network error');
    });
  });

  // -------------------------------------------------------------------------
  // getSystemStatus
  // -------------------------------------------------------------------------

  describe('getSystemStatus', () => {
    it('returns status, version and id from the API', async () => {
      const payload = { status: 'UP', version: '10.4.0', id: 'inst-uuid' };
      fetchSpy = mockFetch(payload);
      const result = await client.getSystemStatus();
      expect(result).toEqual(payload);
    });

    it('calls the correct endpoint', async () => {
      fetchSpy = mockFetch({ status: 'UP', version: '10.4.0' });
      await client.getSystemStatus();
      expect(lastFetchUrl(fetchSpy)).toBe(`${SERVER_URL}/api/system/status`);
    });
  });

  // -------------------------------------------------------------------------
  // getCurrentUser
  // -------------------------------------------------------------------------

  describe('getCurrentUser', () => {
    it('returns the user object on success', async () => {
      fetchSpy = mockFetch({ id: 'user-uuid-123' });
      const user = await client.getCurrentUser();
      expect(user).toEqual({ id: 'user-uuid-123' });
    });

    it('returns null on error', async () => {
      fetchSpy = mockFetch({}, false, 401);
      expect(await client.getCurrentUser()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getOrganizationId
  // -------------------------------------------------------------------------

  describe('getOrganizationId', () => {
    it('hits api.sonarcloud.io, not the serverURL', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch([{ id: 'str-id', uuidV4: 'org-uuid-v4' }]);
      await cloudClient.getOrganizationId('my-org');
      expect(lastFetchUrl(fetchSpy)).toContain(SONARCLOUD_API_URL);
      expect(lastFetchUrl(fetchSpy)).not.toContain(`${SONARCLOUD_URL}/api`);
    });

    it('calls /organizations/organizations with organizationKey param', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch([{ id: 'str-id', uuidV4: 'org-uuid-v4' }]);
      await cloudClient.getOrganizationId('my-org');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/organizations/organizations');
      expect(url.searchParams.get('organizationKey')).toBe('my-org');
    });

    it('hits api.sonarqube.us for US Cloud', async () => {
      const usClient = new SonarQubeClient(SONARCLOUD_US_URL, TOKEN);
      fetchSpy = mockFetch([{ id: 'str-id', uuidV4: 'org-uuid-v4' }]);
      await usClient.getOrganizationId('my-org');
      expect(lastFetchUrl(fetchSpy)).toContain(SONARCLOUD_US_API_URL);
    });

    it('returns the uuidV4 of the first result on success', async () => {
      fetchSpy = mockFetch([{ id: 'str-id', uuidV4: 'org-uuid-v4' }]);
      expect(await client.getOrganizationId('my-org')).toBe('org-uuid-v4');
    });

    it('returns null on error', async () => {
      fetchSpy = mockFetch({}, false, 404);
      expect(await client.getOrganizationId('unknown-org')).toBeNull();
    });

    it('returns null when result array is empty', async () => {
      fetchSpy = mockFetch([]);
      expect(await client.getOrganizationId('my-org')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // checkSqaaEntitlement
  // -------------------------------------------------------------------------

  describe('checkSqaaEntitlement', () => {
    const UUID = 'org-uuid';
    let cloudClient: SonarQubeClient;

    beforeEach(() => {
      cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
    });

    it("returns 'enabled' when the org is currently allowed", async () => {
      fetchSpy = mockFetch({ id: UUID, allowed: true, hasEntitlement: true });
      expect((await cloudClient['checkSqaaEntitlement'](UUID)).status).toBe('enabled');
    });

    it("returns 'over_consumption' when entitled but over its usage limit", async () => {
      fetchSpy = mockFetch({ id: UUID, allowed: false, hasEntitlement: true });
      expect((await cloudClient['checkSqaaEntitlement'](UUID)).status).toBe('over_consumption');
    });

    it("returns 'not_entitled' when the org is not entitled at all", async () => {
      fetchSpy = mockFetch({ id: UUID, allowed: false, hasEntitlement: false });
      expect((await cloudClient['checkSqaaEntitlement'](UUID)).status).toBe('not_entitled');
    });

    it("returns 'check_failed' when the entitlement API errors out", async () => {
      fetchSpy = mockFetch({}, false, 403);
      expect((await cloudClient['checkSqaaEntitlement'](UUID)).status).toBe('check_failed');
    });

    it('hits the SQAA entitlement endpoint with the given UUID', async () => {
      fetchSpy = mockFetch({ id: UUID, allowed: true, hasEntitlement: true });
      await cloudClient['checkSqaaEntitlement'](UUID);
      expect(new URL(lastFetchUrl(fetchSpy)).pathname).toBe(
        `/a3s-analysis/org-entitlement/${UUID}`,
      );
    });

    it('routes to the US API host for SonarQube Cloud US', async () => {
      const usClient = new SonarQubeClient(SONARCLOUD_US_URL, TOKEN);
      fetchSpy = mockFetch({ id: UUID, allowed: true, hasEntitlement: true });
      expect((await usClient['checkSqaaEntitlement'](UUID)).status).toBe('enabled');
      expect(lastFetchUrl(fetchSpy)).toContain(SONARCLOUD_US_API_URL);
    });
  });

  // -------------------------------------------------------------------------
  // checkCagEntitlement
  // -------------------------------------------------------------------------

  describe('checkCagEntitlement', () => {
    const UUID = 'org-uuid';
    let cloudClient: SonarQubeClient;

    beforeEach(() => {
      cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
    });

    it("returns 'enabled' when the org is currently allowed", async () => {
      fetchSpy = mockFetch({ allowed: true, hasEntitlement: true });
      expect((await cloudClient['checkCagEntitlement'](UUID)).status).toBe('enabled');
    });

    it("returns 'over_consumption' when entitled but over its usage limit", async () => {
      fetchSpy = mockFetch({ allowed: false, hasEntitlement: true });
      expect((await cloudClient['checkCagEntitlement'](UUID)).status).toBe('over_consumption');
    });

    it("returns 'not_entitled' when hasEntitlement is false", async () => {
      fetchSpy = mockFetch({ allowed: false, hasEntitlement: false });
      expect((await cloudClient['checkCagEntitlement'](UUID)).status).toBe('not_entitled');
    });

    it("returns 'not_entitled' when hasEntitlement is absent", async () => {
      fetchSpy = mockFetch({});
      expect((await cloudClient['checkCagEntitlement'](UUID)).status).toBe('not_entitled');
    });

    it("returns 'check_failed' when the entitlement API errors out", async () => {
      fetchSpy = mockFetch({}, false, 500);
      expect((await cloudClient['checkCagEntitlement'](UUID)).status).toBe('check_failed');
    });

    it('hits the CAG entitlement endpoint with the given UUID', async () => {
      fetchSpy = mockFetch({ allowed: true, hasEntitlement: true });
      await cloudClient['checkCagEntitlement'](UUID);
      expect(new URL(lastFetchUrl(fetchSpy)).pathname).toBe(`/cag/cag-entitlement/${UUID}`);
    });

    it('forwards the consumption payload when present', async () => {
      fetchSpy = mockFetch({
        allowed: true,
        hasEntitlement: true,
        consumption: { consumed: 15860, limit: 1000000 },
      });
      const result = await cloudClient['checkCagEntitlement'](UUID);
      expect(result.consumption).toEqual({ consumed: 15860, limit: 1000000 });
    });

    it('omits consumption when the response does not include it', async () => {
      fetchSpy = mockFetch({ allowed: true, hasEntitlement: true });
      const result = await cloudClient['checkCagEntitlement'](UUID);
      expect(result.consumption).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // hasVortexEntitlement
  // -------------------------------------------------------------------------

  describe('hasVortexEntitlement', () => {
    let cloudClient: SonarQubeClient;

    beforeEach(() => {
      cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
    });

    it('returns not_entitled when organizationKey is not provided', async () => {
      fetchSpy = mockFetch({});
      expect((await cloudClient.hasVortexEntitlement(undefined)).status).toBe('not_entitled');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns not_entitled when organizationKey is empty string', async () => {
      fetchSpy = mockFetch({});
      expect((await cloudClient.hasVortexEntitlement('')).status).toBe('not_entitled');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns not_entitled when server is not SonarQube Cloud', async () => {
      const serverClient = new SonarQubeClient(SERVER_URL, TOKEN);
      fetchSpy = mockFetch({});
      expect((await serverClient.hasVortexEntitlement('my-org')).status).toBe('not_entitled');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns check_failed when org UUID cannot be resolved', async () => {
      fetchSpy = mockFetch({}, false, 404);
      expect((await cloudClient.hasVortexEntitlement('unknown-org')).status).toBe('check_failed');
    });

    it('returns check_failed when org UUID list is empty', async () => {
      fetchSpy = mockFetch([]);
      expect((await cloudClient.hasVortexEntitlement('my-org')).status).toBe('check_failed');
    });

    it('forwards CAG consumption when the combined status is enabled', async () => {
      const uuid = 'org-uuid';
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((url: string | URL) => {
        const pathname = new URL(url).pathname;
        const body =
          pathname === '/organizations/organizations'
            ? [{ id: 'str-id', uuidV4: uuid }]
            : pathname === `/a3s-analysis/org-entitlement/${uuid}`
              ? { id: uuid, allowed: true, hasEntitlement: true }
              : {
                  allowed: true,
                  hasEntitlement: true,
                  consumption: { consumed: 15860, limit: 1000000 },
                };
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(JSON.stringify(body)),
        } as Response);
      }) as typeof fetch);

      const result = await cloudClient.hasVortexEntitlement('my-org');

      expect(result).toEqual({
        status: 'enabled',
        consumption: { consumed: 15860, limit: 1000000 },
      });
    });

    it('drops consumption when the combined status is over_consumption, even if CAG reports it', async () => {
      const uuid = 'org-uuid';
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((url: string | URL) => {
        const pathname = new URL(url).pathname;
        const body =
          pathname === '/organizations/organizations'
            ? [{ id: 'str-id', uuidV4: uuid }]
            : pathname === `/a3s-analysis/org-entitlement/${uuid}`
              ? { id: uuid, allowed: true, hasEntitlement: true }
              : {
                  allowed: false,
                  hasEntitlement: true,
                  consumption: { consumed: 1000000, limit: 1000000 },
                };
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(JSON.stringify(body)),
        } as Response);
      }) as typeof fetch);

      const result = await cloudClient.hasVortexEntitlement('my-org');

      expect(result).toEqual({ status: 'over_consumption' });
    });
  });

  // -------------------------------------------------------------------------
  // checkComponent
  // -------------------------------------------------------------------------

  describe('checkComponent', () => {
    it('returns true when component exists', async () => {
      fetchSpy = mockFetch({ component: { key: 'my-project' } });
      expect(await client.checkComponent('my-project')).toBe(true);
    });

    it('returns false when component is not found', async () => {
      fetchSpy = mockFetch({}, false, 404);
      expect(await client.checkComponent('missing-project')).toBe(false);
    });

    it('passes the component key as a query parameter', async () => {
      fetchSpy = mockFetch({ component: {} });
      await client.checkComponent('my-project');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.searchParams.get('component')).toBe('my-project');
    });
  });

  // -------------------------------------------------------------------------
  // checkOrganization
  // -------------------------------------------------------------------------

  describe('checkOrganization', () => {
    it('returns true when the organization is in the results', async () => {
      fetchSpy = mockFetch({ organizations: [{ key: 'my-org' }] });
      expect(await client.checkOrganization('my-org')).toBe(true);
    });

    it('returns false when the organization is not in the results', async () => {
      fetchSpy = mockFetch({ organizations: [{ key: 'other-org' }] });
      expect(await client.checkOrganization('my-org')).toBe(false);
    });

    it('returns false on error', async () => {
      fetchSpy = mockFetch({}, false, 500);
      expect(await client.checkOrganization('my-org')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // checkQualityProfiles
  // -------------------------------------------------------------------------

  describe('checkQualityProfiles', () => {
    it('returns true when the request succeeds', async () => {
      fetchSpy = mockFetch({ profiles: [] });
      expect(await client.checkQualityProfiles('my-project')).toBe(true);
    });

    it('passes the project key as a query parameter', async () => {
      fetchSpy = mockFetch({ profiles: [] });
      await client.checkQualityProfiles('my-project');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.searchParams.get('project')).toBe('my-project');
    });

    it('passes the organization key when provided', async () => {
      fetchSpy = mockFetch({ profiles: [] });
      await client.checkQualityProfiles('my-project', 'my-org');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.searchParams.get('organization')).toBe('my-org');
    });

    it('omits the organization key when not provided', async () => {
      fetchSpy = mockFetch({ profiles: [] });
      await client.checkQualityProfiles('my-project');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.searchParams.get('organization')).toBeNull();
    });

    it('returns false on error', async () => {
      fetchSpy = mockFetch({}, false, 403);
      expect(await client.checkQualityProfiles('my-project')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // genericRequest
  // -------------------------------------------------------------------------

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
      const result = await client.genericRequest('GET', '/api/system/status');
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

    it('throws BadRequestError on non-ok POST response', async () => {
      fetchSpy = mockFetch({ message: 'Bad request' }, false, 400);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        client.genericRequest('POST', '/api/issues/do_transition', '{"k":"v"}', 'form'),
      ).rejects.toMatchObject({ name: 'BadRequestError', message: 'Bad request' });
    });

    it('preserves raw body for non-SQAA POST 400 responses', async () => {
      fetchSpy = mockFetch({ errors: [{ msg: 'Transition failed' }] }, false, 400);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        client.genericRequest('POST', '/api/issues/do_transition', '{"k":"v"}', 'form'),
      ).rejects.toMatchObject({
        name: 'BadRequestError',
        message: expect.stringContaining('Transition failed'),
      });
    });

    it('throws access denied on GET 403', async () => {
      fetchSpy = mockFetch({}, false, 403);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.genericRequest('GET', '/api/system/status')).rejects.toThrow(
        'Access denied',
      );
    });

    it('resolves a plain SonarCloud /api endpoint correctly', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch({ ok: true });
      await cloudClient.genericRequest('GET', '/api/issues/search');

      const url = (fetchSpy.mock.calls[0][0] as string).toString();
      expect(url).toBe(`${SONARCLOUD_URL}/api/issues/search`);
    });

    it('strips the /api/v2 prefix and routes to the API host on SonarCloud', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch({ ok: true });
      await cloudClient.genericRequest('GET', '/api/v2/sca/issues-releases');

      const url = (fetchSpy.mock.calls[0][0] as string).toString();
      expect(url).toBe(`${SONARCLOUD_API_URL}/sca/issues-releases`);
    });
  });

  // -------------------------------------------------------------------------
  // createAnalysis
  // -------------------------------------------------------------------------

  describe('createAnalysis', () => {
    const singleFileRequest = {
      organizationKey: 'my-org',
      projectKey: 'my-project',
      files: [{ path: 'src/index.ts', content: 'const x = 1;' }],
    };

    it('sends POST to SONARCLOUD_API_URL for EU Cloud', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await cloudClient.createAnalysis(singleFileRequest);

      const url = lastFetchUrl(fetchSpy);
      expect(url).toBe(`${SONARCLOUD_API_URL}/a3s-analysis/analyses`);
    });

    it('sends POST to SONARCLOUD_US_API_URL for US Cloud', async () => {
      const usClient = new SonarQubeClient(SONARCLOUD_US_URL, TOKEN);
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await usClient.createAnalysis(singleFileRequest);

      const url = lastFetchUrl(fetchSpy);
      expect(url).toBe(`${SONARCLOUD_US_API_URL}/a3s-analysis/analyses`);
    });

    it('sends Bearer token in Authorization header', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.createAnalysis(singleFileRequest);

      const init = lastFetchInit(fetchSpy);
      expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    });

    it('sends request body as JSON with files[]', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.createAnalysis(singleFileRequest);

      const init = lastFetchInit(fetchSpy);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.organizationKey).toBe('my-org');
      expect(body.projectKey).toBe('my-project');
      expect(body.files).toEqual([{ path: 'src/index.ts', content: 'const x = 1;' }]);
      expect(body.analysisDepth).toBeUndefined();
    });

    it('does not include branchName in body when not provided', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.createAnalysis(singleFileRequest);

      const init = lastFetchInit(fetchSpy);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.branchName).toBeUndefined();
    });

    it('includes branchName in body when provided', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.createAnalysis({
        ...singleFileRequest,
        branchName: 'feature/my-branch',
      });

      const init = lastFetchInit(fetchSpy);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.branchName).toBe('feature/my-branch');
    });

    it('includes analysisDepth when provided', async () => {
      fetchSpy = mockFetch({ id: 'a1', issues: [], errors: null });

      await client.createAnalysis({
        ...singleFileRequest,
        analysisDepth: 'DEEP',
      });

      const init = lastFetchInit(fetchSpy);
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.analysisDepth).toBe('DEEP');
    });

    it('returns parsed response', async () => {
      const mockResponse = {
        id: 'analysis-123',
        issues: [{ rule: 'ts:S1234', message: 'Fix this', textRange: null }],
        errors: null,
      };
      fetchSpy = mockFetch(mockResponse);

      const result = await client.createAnalysis(singleFileRequest);

      expect(result.id).toBe('analysis-123');
      expect(result.issues).toHaveLength(1);
    });

    it('throws BadRequestError on structured 400 response', async () => {
      fetchSpy = mockFetch(
        { message: 'Invalid request body', code: 'INVALID_FILE_PATH' },
        false,
        400,
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.createAnalysis(singleFileRequest)).rejects.toMatchObject({
        name: 'BadRequestError',
        message: 'Invalid request body',
        code: 'INVALID_FILE_PATH',
      });
    });

    it('throws RequestPayloadTooLargeError on structured 413 response', async () => {
      fetchSpy = mockFetch(
        {
          message: 'Request payload too large',
          code: 'REQUEST_TOO_LARGE',
          meta: { maxRequestSize: 512_000 },
        },
        false,
        413,
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.createAnalysis(singleFileRequest)).rejects.toMatchObject({
        name: 'RequestPayloadTooLargeError',
        message: 'Request payload too large',
        code: 'REQUEST_TOO_LARGE',
        meta: { maxRequestSize: 512_000 },
      });
    });
  });

  // -------------------------------------------------------------------------
  // getComponentId
  // -------------------------------------------------------------------------

  describe('getComponentId', () => {
    it('returns the component id when found', async () => {
      fetchSpy = mockFetch({ id: 'AYmy-projectlegacy', key: 'my-project' });
      expect(await client.getComponentId('my-project')).toBe('AYmy-projectlegacy');
    });

    it('returns null when component is not found', async () => {
      fetchSpy = mockFetch({}, false, 404);
      expect(await client.getComponentId('missing-project')).toBeNull();
    });

    it('passes the component key as a query parameter to /api/navigation/component', async () => {
      fetchSpy = mockFetch({ id: 'AYlegacy' });
      await client.getComponentId('my-project');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/navigation/component');
      expect(url.searchParams.get('component')).toBe('my-project');
    });
  });

  // -------------------------------------------------------------------------
  // scheduleAgentJob
  // -------------------------------------------------------------------------

  describe('scheduleAgentJob', () => {
    it('sends POST to SONARCLOUD_API_URL for EU Cloud', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch({ taskId: 'task-abc' });
      await cloudClient.scheduleAgentJob({
        projectId: 'proj-id',
        issueKeys: ['KEY-1'],
        triggerSource: 'CLI',
      });
      expect(lastFetchUrl(fetchSpy)).toBe(
        `${SONARCLOUD_API_URL}/fix-suggestions/ai-agent-scheduled-jobs`,
      );
    });

    it('sends POST to SONARCLOUD_US_API_URL for US Cloud', async () => {
      const usClient = new SonarQubeClient(SONARCLOUD_US_URL, TOKEN);
      fetchSpy = mockFetch({ taskId: 'task-abc' });
      await usClient.scheduleAgentJob({
        projectId: 'proj-id',
        issueKeys: ['KEY-1'],
        triggerSource: 'CLI',
      });
      expect(lastFetchUrl(fetchSpy)).toBe(
        `${SONARCLOUD_US_API_URL}/fix-suggestions/ai-agent-scheduled-jobs`,
      );
    });

    it('sends projectId, issueKeys, and triggerSource in the JSON body', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch({ taskId: 'task-abc' });
      await cloudClient.scheduleAgentJob({
        projectId: 'proj-id',
        issueKeys: ['KEY-1', 'KEY-2'],
        triggerSource: 'CLI',
      });
      const body = JSON.parse(lastFetchInit(fetchSpy).body as string) as {
        projectId: string;
        issueKeys: string[];
        triggerSource: string;
      };
      expect(body.projectId).toBe('proj-id');
      expect(body.issueKeys).toEqual(['KEY-1', 'KEY-2']);
      expect(body.triggerSource).toBe('CLI');
    });

    it('returns the parsed taskId from the response', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch({ taskId: 'task-xyz-789' });
      const result = await cloudClient.scheduleAgentJob({
        projectId: 'proj-id',
        issueKeys: ['KEY-1'],
        triggerSource: 'CLI',
      });
      expect(result.taskId).toBe('task-xyz-789');
    });

    it('throws ForbiddenApiError on 403 response', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch({ message: 'Insufficient privileges' }, false, 403);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        cloudClient.scheduleAgentJob({
          projectId: 'proj-id',
          issueKeys: ['KEY-1'],
          triggerSource: 'CLI',
        }),
      ).rejects.toBeInstanceOf(ForbiddenApiError);
    });
  });

  describe('getProjectKeyByGitRemote', () => {
    const remoteUrl = 'https://github.com/foo/bar.git';

    it('returns projectKey from SQS project-bindings API', async () => {
      fetchSpy = mockFetch({
        projectBindings: [{ projectId: 'proj:123', projectKey: 'my-project' }],
      });
      const key = await client.getProjectKeyByGitRemote(remoteUrl);
      expect(key).toBe('my-project');
      expect(lastFetchUrl(fetchSpy)).toBe(
        `${SERVER_URL}/api/v2/dop-translation/project-bindings?repositoryUrl=${encodeURIComponent(remoteUrl)}`,
      );
    });

    it('returns null when SQS has no bindings', async () => {
      fetchSpy = mockFetch({ projectBindings: [] });
      expect(await client.getProjectKeyByGitRemote(remoteUrl)).toBeNull();
    });

    it('returns null when SQS has multiple bindings', async () => {
      fetchSpy = mockFetch({
        projectBindings: [
          { projectId: 'proj:1', projectKey: 'project-a' },
          { projectId: 'proj:2', projectKey: 'project-b' },
        ],
      });
      expect(await client.getProjectKeyByGitRemote(remoteUrl)).toBeNull();
    });

    it('strips embedded credentials from the remote before calling SQS', async () => {
      const remoteWithCredentials = 'https://user:token@github.com/foo/bar.git';
      const sanitizedRemote = 'https://github.com/foo/bar.git';
      fetchSpy = mockFetch({
        projectBindings: [{ projectId: 'proj:123', projectKey: 'my-project' }],
      });
      const key = await client.getProjectKeyByGitRemote(remoteWithCredentials);
      expect(key).toBe('my-project');
      expect(lastFetchUrl(fetchSpy)).toBe(
        `${SERVER_URL}/api/v2/dop-translation/project-bindings?repositoryUrl=${encodeURIComponent(sanitizedRemote)}`,
      );
    });

    it('returns null when SQS project-bindings request fails', async () => {
      fetchSpy = mockFetch({ message: 'not found' }, false, 404);
      expect(await client.getProjectKeyByGitRemote(remoteUrl)).toBeNull();
    });

    it('returns null when SQS binding has no projectKey', async () => {
      fetchSpy = mockFetch({
        projectBindings: [{ projectId: 'proj:123', projectKey: '' }],
      });
      expect(await client.getProjectKeyByGitRemote(remoteUrl)).toBeNull();
    });

    it('resolves SonarCloud project key via bindings then search_projects', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ bindings: [{ projectId: 'proj:abc' }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({ components: [{ key: 'cloud-project-key', name: 'Cloud Project' }] }),
        } as Response);

      const key = await cloudClient.getProjectKeyByGitRemote(remoteUrl, 'my-org');
      expect(key).toBe('cloud-project-key');
      expect((fetchSpy.mock.calls[0][0] as URL).toString()).toBe(
        `${SONARCLOUD_API_URL}/dop-translation/project-bindings?url=${encodeURIComponent(remoteUrl)}`,
      );
      expect((fetchSpy.mock.calls[1][0] as URL).toString()).toContain(
        '/api/components/search_projects?',
      );
      expect((fetchSpy.mock.calls[1][0] as URL).toString()).toContain('organization=my-org');
      expect((fetchSpy.mock.calls[1][0] as URL).toString()).toContain('projectIds=proj%3Aabc');
    });

    it('returns null on SonarCloud when organization is missing', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch({ bindings: [{ projectId: 'proj:abc' }] });
      expect(await cloudClient.getProjectKeyByGitRemote(remoteUrl)).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null when SonarCloud has multiple bindings', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch({
        bindings: [{ projectId: 'proj:a' }, { projectId: 'proj:b' }],
      });
      expect(await cloudClient.getProjectKeyByGitRemote(remoteUrl, 'my-org')).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('strips embedded credentials from the remote before calling SonarCloud', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      const remoteWithCredentials = 'https://user:token@github.com/foo/bar.git';
      const sanitizedRemote = 'https://github.com/foo/bar.git';
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ bindings: [{ projectId: 'proj:abc' }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () =>
            Promise.resolve({ components: [{ key: 'cloud-project-key', name: 'Cloud Project' }] }),
        } as Response);

      const key = await cloudClient.getProjectKeyByGitRemote(remoteWithCredentials, 'my-org');
      expect(key).toBe('cloud-project-key');
      expect((fetchSpy.mock.calls[0][0] as URL).toString()).toBe(
        `${SONARCLOUD_API_URL}/dop-translation/project-bindings?url=${encodeURIComponent(sanitizedRemote)}`,
      );
    });

    it('returns null when SonarCloud project-bindings request fails', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = mockFetch({ message: 'not found' }, false, 404);
      expect(await cloudClient.getProjectKeyByGitRemote(remoteUrl, 'my-org')).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns null when SonarCloud search_projects request fails', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ bindings: [{ projectId: 'proj:abc' }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          json: () => Promise.resolve({ message: 'Insufficient privileges' }),
        } as Response);

      expect(await cloudClient.getProjectKeyByGitRemote(remoteUrl, 'my-org')).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('returns null when SonarCloud search_projects omits components', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({ bindings: [{ projectId: 'proj:abc' }] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: () => Promise.resolve({}),
        } as Response);

      expect(await cloudClient.getProjectKeyByGitRemote(remoteUrl, 'my-org')).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('getServerMode', () => {
    it('returns mqr immediately for SonarQube Cloud without calling the API', async () => {
      const cloudClient = new SonarQubeClient(SONARCLOUD_URL, TOKEN);
      fetchSpy = spyOn(globalThis, 'fetch');
      expect(await cloudClient.getServerMode()).toBe('mqr');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns mqr when server responds with MQR mode', async () => {
      fetchSpy = mockFetch({ mode: 'MQR' });
      expect(await client.getServerMode()).toBe('mqr');
    });

    it('returns standard when server responds with STANDARD mode', async () => {
      fetchSpy = mockFetch({ mode: 'STANDARD' });
      expect(await client.getServerMode()).toBe('standard');
    });

    it('returns standard when endpoint returns 404 (old server without MQR support)', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('Not Found'),
      } as Response);
      expect(await client.getServerMode()).toBe('standard');
    });

    it('throws when endpoint returns a server error', async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      } as Response);
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.getServerMode()).rejects.toThrow();
    });
  });
});

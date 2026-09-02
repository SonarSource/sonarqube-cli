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

// Real Bun server tests: verify that redirect: 'manual' exposes a readable
// 3xx status and Location header in this runtime, which is the assumption
// fetchAuthenticated() relies on.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { NetworkConfigError } from '@/core/errors.ts';
import { clearNetworkConfigCache } from '@/core/host/connectivity/network-config.ts';
import { buildRequest, fetchAnonymous, fetchAuthenticated } from '@/core/server/fetch.ts';

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      switch (url.pathname) {
        case '/redirect-same-origin':
          return new Response(null, {
            status: 302,
            headers: { Location: `${base}/target` },
          });
        case '/redirect-cross-origin':
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://evil.example.com/steal' },
          });
        case '/redirect-chain':
          return new Response(null, {
            status: 301,
            headers: { Location: `${base}/target` },
          });
        case '/target':
          return new Response('ok', { status: 200 });
        default:
          return new Response('not found', { status: 404 });
      }
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server.stop();
});

describe('fetchAuthenticated — proxy recomputation on scheme change', () => {
  beforeEach(() => {
    process.env.SONAR_HTTP_PROXY_URL = 'https://http-proxy:3128';
    process.env.SONAR_HTTPS_PROXY_URL = 'https://https-proxy:8443';
    clearNetworkConfigCache();
  });

  afterEach(() => {
    delete process.env.SONAR_HTTP_PROXY_URL;
    delete process.env.SONAR_HTTPS_PROXY_URL;
    clearNetworkConfigCache();
  });

  it('switches from HTTP proxy to HTTPS proxy after HTTP→HTTPS upgrade redirect', async () => {
    const originalUrl = 'http://sonar.internal:8080/api';
    const init = buildRequest('GET', {}, 30000, undefined);

    const captured: Array<Record<string, unknown>> = [];
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((
      _url: string | URL | Request,
      options?: RequestInit,
    ) => {
      captured.push({ ...(options as Record<string, unknown>) });
      if (captured.length === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 301,
            headers: { Location: 'https://sonar.internal:8080/api' },
          }),
        );
      }
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch);

    try {
      await fetchAuthenticated(originalUrl, init);
      expect(captured[0]?.proxy).toBe('https://http-proxy:3128');
      expect(captured[1]?.proxy).toBe('https://https-proxy:8443');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('fetchAuthenticated — real Bun runtime redirect behavior', () => {
  it('redirect: manual returns readable 3xx status and Location in Bun', async () => {
    // Verifies the core runtime assumption: Bun exposes status and Location
    // header for redirect: 'manual' responses (unlike spec-compliant opaque redirects).
    const res = await fetch(`${base}/redirect-same-origin`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/target');
  });

  it('follows a same-origin redirect to the final response', async () => {
    const res = await fetchAuthenticated(`${base}/redirect-same-origin`, {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('follows a 301 redirect chain', async () => {
    const res = await fetchAuthenticated(`${base}/redirect-chain`, {});
    expect(res.status).toBe(200);
  });

  it('throws on a cross-origin redirect without making a second request', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(fetchAuthenticated(`${base}/redirect-cross-origin`, {})).rejects.toThrow(
      'cross-origin redirect',
    );
  });
});

describe('fetchAnonymous', () => {
  beforeEach(() => {
    process.env.SONAR_HTTPS_PROXY_URL = 'https://https-proxy:8443';
    clearNetworkConfigCache();
  });

  afterEach(() => {
    delete process.env.SONAR_HTTPS_PROXY_URL;
    clearNetworkConfigCache();
  });

  function spyOnFetch(captured: Array<Record<string, unknown>>) {
    return spyOn(globalThis, 'fetch').mockImplementation(((
      _url: string | URL | Request,
      options?: RequestInit,
    ) => {
      captured.push({ ...(options as Record<string, unknown>) });
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as unknown as typeof fetch);
  }

  it('applies the resolved proxy for the requested URL', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const fetchSpy = spyOnFetch(captured);

    try {
      await fetchAnonymous('https://sonar.example.com/api', { method: 'GET' });
      expect(captured[0]?.proxy).toBe('https://https-proxy:8443');
      expect(captured[0]?.method).toBe('GET');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('drops proxy and TLS options set by the call site', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const fetchSpy = spyOnFetch(captured);

    try {
      await fetchAnonymous('https://sonar.example.com/api', {
        proxy: 'https://attacker-proxy:3128',
        tls: { rejectUnauthorized: false },
      } as RequestInit);
      expect(captured[0]?.proxy).toBe('https://https-proxy:8443');
      expect(captured[0]?.tls).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects a credentialed request, which must go through fetchAuthenticated', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const fetchSpy = spyOnFetch(captured);

    try {
      for (const header of ['Authorization', 'private-token', 'X-Api-Key', 'Cookie']) {
        // eslint-disable-next-line @typescript-eslint/await-thenable
        await expect(
          fetchAnonymous('https://sonar.example.com/api', {
            headers: { [header]: 's3cret' },
          }),
        ).rejects.toThrow('use fetchAuthenticated');
      }
      expect(captured).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('propagates a network configuration error instead of connecting directly', async () => {
    process.env.SONAR_TLS_CLIENT_CERT = '/does/not/exist.pem';
    process.env.SONAR_TLS_CLIENT_KEY_FILE = '/does/not/exist.key';
    clearNetworkConfigCache();
    const captured: Array<Record<string, unknown>> = [];
    const fetchSpy = spyOnFetch(captured);

    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(fetchAnonymous('https://sonar.example.com/api')).rejects.toThrow(
        NetworkConfigError,
      );
      expect(captured).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.SONAR_TLS_CLIENT_CERT;
      delete process.env.SONAR_TLS_CLIENT_KEY_FILE;
      clearNetworkConfigCache();
    }
  });
});

const SERVER_URL = 'https://sonarqube.example.com';

describe('fetchAuthenticated — redirect semantics', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

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

    const res = await fetchAuthenticated(`${SERVER_URL}/old-path`, {});
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
    await expect(fetchAuthenticated(`${SERVER_URL}/api`, {})).rejects.toThrow(
      'cross-origin redirect',
    );
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

    const res = await fetchAuthenticated(httpUrl, {});
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

    const res = await fetchAuthenticated(`${SERVER_URL}/api`, {});
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

    await fetchAuthenticated(`${SERVER_URL}/api`, { method: 'POST', body: '{"key":"val"}' });

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

    await fetchAuthenticated(`${SERVER_URL}/api`, {
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

    await fetchAuthenticated(`${SERVER_URL}/api`, { method: 'POST', body: '{"key":"val"}' });

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
    await expect(fetchAuthenticated(`${SERVER_URL}/loop`, {})).rejects.toThrow(
      'too many redirects',
    );
  });
});

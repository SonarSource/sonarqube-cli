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
// fetchGuarded() relies on.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import {
  buildFetchNetworkOptions,
  clearNetworkConfigCache,
} from '@/core/host/connectivity/network-config.js';

import { buildFetchInit, fetchGuarded } from '../../../src/lib/fetch-guarded.js';

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

describe('fetchGuarded — proxy recomputation on scheme change', () => {
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
    const init = buildFetchInit('GET', {}, 30000, undefined, buildFetchNetworkOptions(originalUrl));

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
      await fetchGuarded(originalUrl, init);
      expect(captured[0]?.proxy).toBe('https://http-proxy:3128');
      expect(captured[1]?.proxy).toBe('https://https-proxy:8443');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('fetchGuarded — real Bun runtime redirect behavior', () => {
  it('redirect: manual returns readable 3xx status and Location in Bun', async () => {
    // Verifies the core runtime assumption: Bun exposes status and Location
    // header for redirect: 'manual' responses (unlike spec-compliant opaque redirects).
    const res = await fetch(`${base}/redirect-same-origin`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/target');
  });

  it('follows a same-origin redirect to the final response', async () => {
    const res = await fetchGuarded(`${base}/redirect-same-origin`, {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('follows a 301 redirect chain', async () => {
    const res = await fetchGuarded(`${base}/redirect-chain`, {});
    expect(res.status).toBe(200);
  });

  it('throws on a cross-origin redirect without making a second request', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(fetchGuarded(`${base}/redirect-cross-origin`, {})).rejects.toThrow(
      'cross-origin redirect',
    );
  });
});

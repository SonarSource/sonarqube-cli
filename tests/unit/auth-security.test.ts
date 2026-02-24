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

// Tests for security features of the loopback OAuth server:
// response headers, DNS rebinding protection, Host header validation, body size limits

import { describe, it, expect, afterEach } from 'bun:test';

import { createRequestHandler } from '../../src/bootstrap/auth.js';
import { startLoopbackServer, type LoopbackServerResult } from '../../src/lib/loopback-server.js';

const LOOPBACK_HOST = '127.0.0.1';
const HTTP_SCHEME = 'http';
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
const MAX_POST_BODY_BYTES = 4096;
// DNS rebinding test origins (intentionally non-loopback, must be http for origin validation)
const EXTERNAL_ORIGIN = `${HTTP_SCHEME}://evil.com`;
const NON_LOOPBACK_ORIGIN = `${HTTP_SCHEME}://192.168.1.100:3000`;

function serverUrl(port: number): string {
  return `${HTTP_SCHEME}://${LOOPBACK_HOST}:${port}`;
}

describe('Auth: security features via real HTTP', () => {
  let server: LoopbackServerResult | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  // ─── Security headers on responses ──────────────────────────────

  it('should include all security headers on POST response with token', async () => {
    const handler = createRequestHandler(() => {});
    server = await startLoopbackServer(handler);

    const response = await fetch(serverUrl(server.port), {
      method: 'POST',
      body: JSON.stringify({ token: 'squ_headers_test' }),
    });

    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; connect-src 'self'"
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('should include all security headers on GET response', async () => {
    const handler = createRequestHandler(() => {});
    server = await startLoopbackServer(handler);

    const response = await fetch(`${serverUrl(server.port)}/?token=squ_test`);

    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('should include security headers on unexpected method response', async () => {
    const handler = createRequestHandler(() => {});
    server = await startLoopbackServer(handler);

    const response = await fetch(serverUrl(server.port), { method: 'PUT', body: 'x' });

    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  // ─── DNS rebinding protection ────────────────────────────────────

  it('should reject requests from external Origin with 403', async () => {
    const handler = createRequestHandler(() => {});
    server = await startLoopbackServer(handler);

    const response = await fetch(serverUrl(server.port), {
      method: 'GET',
      headers: { Origin: EXTERNAL_ORIGIN },
    });

    expect(response.status).toBe(HTTP_STATUS_FORBIDDEN);
  });

  it('should reject requests from non-loopback Origin', async () => {
    const handler = createRequestHandler(() => {});
    server = await startLoopbackServer(handler);

    const response = await fetch(serverUrl(server.port), {
      method: 'POST',
      body: JSON.stringify({ token: 'squ_stolen' }),
      headers: { Origin: NON_LOOPBACK_ORIGIN },
    });

    expect(response.status).toBe(HTTP_STATUS_FORBIDDEN);
  });

  it('should allow requests from localhost Origin', async () => {
    const handler = createRequestHandler(() => {});
    server = await startLoopbackServer(handler);

    const response = await fetch(`${serverUrl(server.port)}/?token=squ_ok`, {
      headers: { Origin: `${HTTP_SCHEME}://localhost:${server.port}` },
    });

    expect(response.status).toBe(HTTP_STATUS_OK);
  });

  it('should allow requests from 127.0.0.1 Origin', async () => {
    const handler = createRequestHandler(() => {});
    server = await startLoopbackServer(handler);

    const response = await fetch(`${serverUrl(server.port)}/?token=squ_ok`, {
      headers: { Origin: serverUrl(server.port) },
    });

    expect(response.status).toBe(HTTP_STATUS_OK);
  });

  it('should allow requests without Origin header (same-origin)', async () => {
    let receivedToken: string | undefined;

    const handler = createRequestHandler((token: string) => {
      receivedToken = token;
    });
    server = await startLoopbackServer(handler);

    const response = await fetch(`${serverUrl(server.port)}/?token=squ_no_origin`);

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(receivedToken).toBe('squ_no_origin');
  });

  // ─── Host header validation (defense-in-depth) ──────────────────

  it('should reject requests with non-loopback Host header', async () => {
    const handler = createRequestHandler(() => {});
    server = await startLoopbackServer(handler);

    const response = await fetch(serverUrl(server.port), {
      headers: { Host: 'evil.com:8080' },
    });

    expect(response.status).toBe(HTTP_STATUS_FORBIDDEN);
  });

  it('should accept requests with loopback Host header', async () => {
    let receivedToken: string | undefined;

    const handler = createRequestHandler((token: string) => {
      receivedToken = token;
    });
    server = await startLoopbackServer(handler);

    const response = await fetch(`${serverUrl(server.port)}/?token=squ_host_ok`, {
      headers: { Host: `${LOOPBACK_HOST}:${server.port}` },
    });

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(receivedToken).toBe('squ_host_ok');
  });

  it('should reject requests with attacker subdomain Host header', async () => {
    const handler = createRequestHandler(() => {});
    server = await startLoopbackServer(handler);

    const response = await fetch(serverUrl(server.port), {
      headers: { Host: 'attacker.localhost:8080' },
    });

    expect(response.status).toBe(HTTP_STATUS_FORBIDDEN);
  });

  // ─── POST body size limit ────────────────────────────────────────

  it('should reject POST body exceeding 4KB limit with 413', async () => {
    const handler = createRequestHandler(() => {});
    server = await startLoopbackServer(handler);

    const oversizedBody = JSON.stringify({ token: 'x'.repeat(MAX_POST_BODY_BYTES) });

    const response = await fetch(serverUrl(server.port), {
      method: 'POST',
      body: oversizedBody,
    });

    expect(response.status).toBe(HTTP_STATUS_PAYLOAD_TOO_LARGE);
  });

  it('should accept POST body within 4KB limit', async () => {
    let receivedToken: string | undefined;

    const handler = createRequestHandler((token: string) => {
      receivedToken = token;
    });
    server = await startLoopbackServer(handler);

    const response = await fetch(serverUrl(server.port), {
      method: 'POST',
      body: JSON.stringify({ token: 'squ_normal_size_token' }),
    });

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(receivedToken).toBe('squ_normal_size_token');
  });

  it('should not invoke token callback when body exceeds limit', async () => {
    let callbackInvoked = false;

    const handler = createRequestHandler(() => {
      callbackInvoked = true;
    });
    server = await startLoopbackServer(handler);

    const oversizedBody = JSON.stringify({ token: 'x'.repeat(MAX_POST_BODY_BYTES) });

    await fetch(serverUrl(server.port), {
      method: 'POST',
      body: oversizedBody,
    });

    expect(callbackInvoked).toBe(false);
  });

  // ─── CORS preflight ──────────────────────────────────────────────

  it('should handle OPTIONS preflight with security headers', async () => {
    const handler = createRequestHandler(() => {});
    server = await startLoopbackServer(handler);

    const response = await fetch(serverUrl(server.port), {
      method: 'OPTIONS',
    });

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; connect-src 'self'"
    );
  });
});

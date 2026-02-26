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

// Tests for OAuth token extraction via real loopback HTTP server

import { describe, it, expect, afterEach } from 'bun:test';

import { createRequestHandler } from '../../src/bootstrap/auth.js';
import { startLoopbackServer, type LoopbackServerResult } from '../../src/lib/loopback-server.js';

const LOOPBACK_HOST = '127.0.0.1';
const HTTP_SCHEME = 'http';
const HTTP_STATUS_OK = 200;
const LONG_TOKEN_PADDING_LENGTH = 200;
const EVENT_SETTLE_DELAY_MS = 50;

function serverUrl(port: number): string {
  return `${HTTP_SCHEME}://${LOOPBACK_HOST}:${port}`;
}

describe('Auth: OAuth token flow via real HTTP', () => {
  let server: LoopbackServerResult | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  // ─── POST token extraction ───────────────────────────────────────

  it('should extract token from POST JSON body and invoke callback', async () => {
    let receivedToken: string | undefined;

    const handler = createRequestHandler((token: string) => {
      receivedToken = token;
    });
    server = await startLoopbackServer(handler);

    const response = await fetch(serverUrl(server.port), {
      method: 'POST',
      body: JSON.stringify({ token: 'squ_post_token_abc' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(receivedToken).toBe('squ_post_token_abc');

    const body = await response.text();
    expect(body).toContain('Authentication Successful');
  });

  it('should extract long token from POST body', async () => {
    let receivedToken: string | undefined;

    const handler = createRequestHandler((token: string) => {
      receivedToken = token;
    });
    server = await startLoopbackServer(handler);

    const longToken = 'squ_' + 'a'.repeat(LONG_TOKEN_PADDING_LENGTH);
    const response = await fetch(serverUrl(server.port), {
      method: 'POST',
      body: JSON.stringify({ token: longToken }),
    });

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(receivedToken).toBe(longToken);
  });

  // ─── GET token extraction ────────────────────────────────────────

  it('should extract token from GET query parameter and invoke callback', async () => {
    let receivedToken: string | undefined;

    const handler = createRequestHandler((token: string) => {
      receivedToken = token;
    });
    server = await startLoopbackServer(handler);

    const response = await fetch(`${serverUrl(server.port)}/?token=squ_get_token_xyz`, {
      method: 'GET',
    });

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(receivedToken).toBe('squ_get_token_xyz');
  });

  it('should extract URL-encoded token from GET query', async () => {
    let receivedToken: string | undefined;

    const handler = createRequestHandler((token: string) => {
      receivedToken = token;
    });
    server = await startLoopbackServer(handler);

    const encodedToken = encodeURIComponent('squ_special_chars!@#');
    const response = await fetch(`${serverUrl(server.port)}/?token=${encodedToken}`);

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(receivedToken).toBe('squ_special_chars!@#');
  });

  it('should extract token from GET with multiple query parameters', async () => {
    let receivedToken: string | undefined;

    const handler = createRequestHandler((token: string) => {
      receivedToken = token;
    });
    server = await startLoopbackServer(handler);

    const response = await fetch(
      `${serverUrl(server.port)}/?user=john&token=squ_multi_param&org=acme`,
    );

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(receivedToken).toBe('squ_multi_param');
  });

  // ─── Missing / invalid tokens ────────────────────────────────────

  it('should not invoke callback when POST body has no token field', async () => {
    let callbackCalled = false;

    const handler = createRequestHandler(() => {
      callbackCalled = true;
    });
    server = await startLoopbackServer(handler);

    const response = await fetch(serverUrl(server.port), {
      method: 'POST',
      body: JSON.stringify({ user: 'john', data: 'something' }),
    });

    expect(response.status).toBe(HTTP_STATUS_OK);
    await new Promise((resolve) => setTimeout(resolve, EVENT_SETTLE_DELAY_MS));
    expect(callbackCalled).toBe(false);
  });

  it('should not invoke callback when POST body is invalid JSON', async () => {
    let callbackCalled = false;

    const handler = createRequestHandler(() => {
      callbackCalled = true;
    });
    server = await startLoopbackServer(handler);

    const response = await fetch(serverUrl(server.port), {
      method: 'POST',
      body: 'not valid json at all',
    });

    expect(response.status).toBe(HTTP_STATUS_OK);
    await new Promise((resolve) => setTimeout(resolve, EVENT_SETTLE_DELAY_MS));
    expect(callbackCalled).toBe(false);
  });

  it('should not invoke callback when GET has no token parameter', async () => {
    let callbackCalled = false;

    const handler = createRequestHandler(() => {
      callbackCalled = true;
    });
    server = await startLoopbackServer(handler);

    const response = await fetch(`${serverUrl(server.port)}/?user=john`);

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(callbackCalled).toBe(false);
  });

  it('should not invoke callback when GET token is empty', async () => {
    let callbackCalled = false;

    const handler = createRequestHandler(() => {
      callbackCalled = true;
    });
    server = await startLoopbackServer(handler);

    const response = await fetch(`${serverUrl(server.port)}/?token=`);

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(callbackCalled).toBe(false);
  });

  // ─── Unexpected HTTP methods ─────────────────────────────────────

  it('should respond 200 OK for unexpected HTTP methods (PUT)', async () => {
    let callbackCalled = false;

    const handler = createRequestHandler(() => {
      callbackCalled = true;
    });
    server = await startLoopbackServer(handler);

    const response = await fetch(serverUrl(server.port), {
      method: 'PUT',
      body: 'test',
    });

    expect(response.status).toBe(HTTP_STATUS_OK);
    const body = await response.text();
    expect(body).toBe('OK');
    expect(callbackCalled).toBe(false);
  });

  it('should respond 200 OK for DELETE method without invoking callback', async () => {
    let callbackCalled = false;

    const handler = createRequestHandler(() => {
      callbackCalled = true;
    });
    server = await startLoopbackServer(handler);

    const response = await fetch(serverUrl(server.port), {
      method: 'DELETE',
    });

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(callbackCalled).toBe(false);
  });

  // ─── Token promise resolution ─────────────────────────────────────

  it('should resolve token promise when POST delivers valid token', async () => {
    let resolveToken: ((token: string) => void) | null = null;
    const tokenPromise = new Promise<string>((resolve) => {
      resolveToken = resolve;
    });

    const handler = createRequestHandler((token: string) => {
      if (resolveToken) resolveToken(token);
    });
    server = await startLoopbackServer(handler);

    await fetch(serverUrl(server.port), {
      method: 'POST',
      body: JSON.stringify({ token: 'squ_promise_test_123' }),
    });

    const token = await tokenPromise;
    expect(token).toBe('squ_promise_test_123');
  });

  it('should resolve token promise when GET delivers valid token', async () => {
    let resolveToken: ((token: string) => void) | null = null;
    const tokenPromise = new Promise<string>((resolve) => {
      resolveToken = resolve;
    });

    const handler = createRequestHandler((token: string) => {
      if (resolveToken) resolveToken(token);
    });
    server = await startLoopbackServer(handler);

    await fetch(`${serverUrl(server.port)}/?token=squ_get_promise_456`);

    const token = await tokenPromise;
    expect(token).toBe('squ_get_promise_456');
  });

  // ─── User headers preserved ───────────────────────────────────────

  it('should preserve user Content-Type header alongside security headers', async () => {
    const handler = createRequestHandler(() => {});
    server = await startLoopbackServer(handler);

    const response = await fetch(`${serverUrl(server.port)}/?token=squ_test`);

    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  // ─── Sequential requests ──────────────────────────────────────────

  it('should handle multiple sequential requests on same server', async () => {
    const tokens: string[] = [];

    const handler = createRequestHandler((token: string) => {
      tokens.push(token);
    });
    server = await startLoopbackServer(handler);

    await fetch(`${serverUrl(server.port)}/?token=squ_first`);
    await fetch(serverUrl(server.port), {
      method: 'POST',
      body: JSON.stringify({ token: 'squ_second' }),
    });

    expect(tokens).toEqual(['squ_first', 'squ_second']);
  });
});

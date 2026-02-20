// Scenario-based tests for auth module through real HTTP server
// Tests the complete flow: loopback server + auth request handlers + token extraction

import { describe, it, expect, afterEach, beforeEach, mock } from 'bun:test';

// Mock browser module BEFORE importing auth (prevents actual browser opening during tests)
const mockOpenBrowser = mock(() => Promise.resolve());
mock.module('../../src/lib/browser.js', () => ({
  openBrowser: mockOpenBrowser,
}));

import {
  createRequestHandler,
  generateTokenViaBrowser,
  getToken,
  saveToken,
  deleteToken,
  validateToken,
  openBrowserWithFallback,
  buildAuthURL,
  getSuccessHTML,
} from '../../src/bootstrap/auth.js';
import { startLoopbackServer, type LoopbackServerResult } from '../../src/lib/loopback-server.js';
import { setMockKeytar, clearTokenCache } from '../../src/lib/keychain.js';

const LOOPBACK_HOST = '127.0.0.1';
const HTTP_SCHEME = 'http';
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
const MAX_POST_BODY_BYTES = 4096;
const LONG_TOKEN_PADDING_LENGTH = 200;
const EVENT_SETTLE_DELAY_MS = 50;
const PORT_SCAN_DELAY_MS = 150;
const PORT_SCAN_TIMEOUT_MS = 100;
const MIN_PORT = 64130;
const MAX_PORT = 64140;
const TEST_PORT_A = 64130;
const TEST_PORT_B = 64135;
// DNS rebinding test origins (intentionally non-loopback, must be http for origin validation)
const EXTERNAL_ORIGIN = `${HTTP_SCHEME}://evil.com`;
const NON_LOOPBACK_ORIGIN = `${HTTP_SCHEME}://192.168.1.100:3000`;

function serverUrl(port: number): string {
  return `${HTTP_SCHEME}://${LOOPBACK_HOST}:${port}`;
}

/**
 * Scan port range to find an active server (used for generateTokenViaBrowser tests)
 */
async function findActivePort(minPort: number, maxPort: number): Promise<number> {
  for (let port = minPort; port <= maxPort; port++) {
    try {
      await fetch(serverUrl(port), {
        method: 'HEAD',
        signal: AbortSignal.timeout(PORT_SCAN_TIMEOUT_MS),
      });
      return port;
    } catch {
      // Port not active, try next
    }
  }
  throw new Error('No active server found in port range');
}

describe('Auth Scenarios: OAuth token flow via real HTTP', () => {
  let server: LoopbackServerResult | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  // ─── Scenario: POST token extraction ───────────────────────────

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

  // ─── Scenario: GET token extraction ────────────────────────────

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
      `${serverUrl(server.port)}/?user=john&token=squ_multi_param&org=acme`
    );

    expect(response.status).toBe(HTTP_STATUS_OK);
    expect(receivedToken).toBe('squ_multi_param');
  });

  // ─── Scenario: Missing/invalid tokens ─────────────────────────

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
    await new Promise(resolve => setTimeout(resolve, EVENT_SETTLE_DELAY_MS));
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
    await new Promise(resolve => setTimeout(resolve, EVENT_SETTLE_DELAY_MS));
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

  // ─── Scenario: Unexpected HTTP methods ─────────────────────────

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

  // ─── Scenario: Security headers on responses ──────────────────

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

  // ─── Scenario: DNS rebinding protection ────────────────────────

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

  // ─── Scenario: Host header validation (defense-in-depth) ──────

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

  // ─── Scenario: POST body size limit ─────────────────────────

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

  // ─── Scenario: CORS preflight ─────────────────────────────────

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

  // ─── Scenario: Token promise resolution ────────────────────────

  it('should resolve token promise when POST delivers valid token', async () => {
    let resolveToken: ((token: string) => void) | null = null;
    const tokenPromise = new Promise<string>(resolve => {
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
    const tokenPromise = new Promise<string>(resolve => {
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

  // ─── Scenario: User headers merged with security headers ──────

  it('should preserve user Content-Type header alongside security headers', async () => {
    const handler = createRequestHandler(() => {});
    server = await startLoopbackServer(handler);

    const response = await fetch(`${serverUrl(server.port)}/?token=squ_test`);

    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  // ─── Scenario: Sequential requests ────────────────────────────

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

// ─── Scenario: Keychain wrapper functions ──────────────────────────

describe('Auth Scenarios: keychain token management', () => {
  const mockStore = new Map<string, string>();
  const SONARCLOUD_URL = 'https://sonarcloud.io';
  const ONPREM_URL = 'https://sonar.example.com';

  beforeEach(() => {
    mockStore.clear();
    clearTokenCache();
    setMockKeytar({
      getPassword: async (_service: string, account: string) => mockStore.get(account) ?? null,
      setPassword: async (_service: string, account: string, password: string) => {
        mockStore.set(account, password);
      },
      deletePassword: async (_service: string, account: string) => {
        return mockStore.delete(account);
      },
      findCredentials: async () => [],
    });
  });

  afterEach(() => {
    setMockKeytar(null);
    clearTokenCache();
  });

  it('should save and retrieve token for SonarCloud with org', async () => {
    await saveToken(SONARCLOUD_URL, 'squ_cloud_token', 'my-org');
    const token = await getToken(SONARCLOUD_URL, 'my-org');
    expect(token).toBe('squ_cloud_token');
  });

  it('should save and retrieve token for on-premise server', async () => {
    await saveToken(ONPREM_URL, 'squ_onprem_token');
    const token = await getToken(ONPREM_URL);
    expect(token).toBe('squ_onprem_token');
  });

  it('should return null when no token is stored', async () => {
    const token = await getToken(SONARCLOUD_URL, 'no-org');
    expect(token).toBeNull();
  });

  it('should delete token and return null on subsequent get', async () => {
    await saveToken(SONARCLOUD_URL, 'squ_to_delete', 'org');
    await deleteToken(SONARCLOUD_URL, 'org');
    const token = await getToken(SONARCLOUD_URL, 'org');
    expect(token).toBeNull();
  });

  it('should keep tokens isolated between different servers', async () => {
    await saveToken(SONARCLOUD_URL, 'squ_cloud', 'org');
    await saveToken(ONPREM_URL, 'squ_onprem');

    const cloud = await getToken(SONARCLOUD_URL, 'org');
    const onprem = await getToken(ONPREM_URL);

    expect(cloud).toBe('squ_cloud');
    expect(onprem).toBe('squ_onprem');
  });
});

// ─── Scenario: generateTokenViaBrowser integration ─────────────────

describe('Auth Scenarios: generateTokenViaBrowser full flow', () => {
  let originalStdin: typeof process.stdin;

  beforeEach(() => {
    originalStdin = process.stdin;

    // Mock stdin so waitForUserInput resolves immediately
    const mockStdin = {
      setEncoding: mock(() => {}),
      resume: mock(() => {}),
      pause: mock(() => {}),
      removeListener: mock(() => {}),
      unref: mock(() => {}),
      once: mock((_event: string, callback: () => void) => {
        // Immediately invoke the data callback to skip "Press Enter"
        setTimeout(callback, 0);
      }),
    };

    Object.defineProperty(process, 'stdin', {
      value: mockStdin,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      writable: true,
      configurable: true,
    });
  });

  it('should complete full OAuth flow: start server, receive POST token, resolve', async () => {
    // Start the auth flow in the background
    const tokenPromise = generateTokenViaBrowser('https://sonarcloud.io');

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, PORT_SCAN_DELAY_MS));

    // Find which port the server is on
    const port = await findActivePort(MIN_PORT, MAX_PORT);

    // Simulate SonarQube OAuth callback via POST
    await fetch(serverUrl(port), {
      method: 'POST',
      body: JSON.stringify({ token: 'squ_browser_flow_token' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const token = await tokenPromise;
    expect(token).toBe('squ_browser_flow_token');
  });

  it('should complete full OAuth flow with GET token callback', async () => {
    const tokenPromise = generateTokenViaBrowser('https://sonarcloud.io');

    await new Promise(resolve => setTimeout(resolve, PORT_SCAN_DELAY_MS));

    const port = await findActivePort(MIN_PORT, MAX_PORT);

    // Simulate SonarQube OAuth callback via GET
    await fetch(`${serverUrl(port)}/?token=squ_get_flow_token`);

    const token = await tokenPromise;
    expect(token).toBe('squ_get_flow_token');
  });
});

// ─── Scenario: validateToken error handling ─────────────────────────

describe('Auth Scenarios: validateToken error handling', () => {
  it('should return false when server is unreachable', async () => {
    // Port 1 is reserved - connection refused immediately
    const result = await validateToken(`${HTTP_SCHEME}://${LOOPBACK_HOST}:1`, 'squ_test_token');
    expect(result).toBe(false);
  });

  it('should return false for invalid server URL', async () => {
    const result = await validateToken('not-a-url', 'squ_test');
    expect(result).toBe(false);
  });
});

// ─── Scenario: openBrowserWithFallback ──────────────────────────────

describe('Auth Scenarios: openBrowserWithFallback', () => {
  beforeEach(() => {
    mockOpenBrowser.mockClear();
  });

  it('should call openBrowser with the auth URL', async () => {
    await openBrowserWithFallback('https://sonarcloud.io/test');
    expect(mockOpenBrowser).toHaveBeenCalledWith('https://sonarcloud.io/test');
  });

  it('should not throw when browser opening fails', async () => {
    mockOpenBrowser.mockImplementationOnce(() => Promise.reject(new Error('No browser found')));

    await expect(
      openBrowserWithFallback('https://sonarcloud.io/test')
    ).resolves.toBeUndefined();
  });
});

// ─── Scenario: buildAuthURL correctness ─────────────────────────────

describe('Auth Scenarios: buildAuthURL correctness', () => {
  it('should build auth URL that includes all required parameters', () => {
    const url = buildAuthURL('https://sonarcloud.io', TEST_PORT_A);
    const parsed = new URL(url);

    expect(parsed.hostname).toBe('sonarcloud.io');
    expect(parsed.pathname).toBe('/sonarlint/auth');
    expect(parsed.searchParams.get('ideName')).toBe('sonarqube-cli');
    expect(parsed.searchParams.get('port')).toBe(String(TEST_PORT_A));
  });

  it('should strip trailing slash from server URL', () => {
    const url = buildAuthURL('https://sonar.example.com/', TEST_PORT_B);
    expect(url).not.toContain('sonar.example.com//');
    expect(url).toContain('sonar.example.com/sonarlint/auth');
  });
});

// ─── Scenario: getSuccessHTML structure ─────────────────────────────

describe('Auth Scenarios: getSuccessHTML structure', () => {
  it('should return a complete HTML document with required elements', () => {
    const html = getSuccessHTML();

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
    expect(html).toContain('Authentication Successful');
    expect(html).toContain('return to the terminal');
    expect(html).toContain('✓');
  });
});

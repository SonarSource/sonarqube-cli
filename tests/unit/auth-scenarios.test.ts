// Scenario-based tests for auth module: keychain token management,
// browser OAuth flow, token validation, URL building, and HTML output

import { describe, it, expect, afterEach, beforeEach, mock, spyOn } from 'bun:test';

// Mock browser module BEFORE importing auth (prevents actual browser opening during tests)
const mockOpenBrowser = mock((_url: string) => Promise.resolve());
mock.module('../../src/lib/browser.js', () => ({
  openBrowser: mockOpenBrowser,
}));

import {
  generateTokenViaBrowser,
  getToken,
  saveToken,
  deleteToken,
  validateToken,
  openBrowserWithFallback,
  buildAuthURL,
  getSuccessHTML,
} from '../../src/bootstrap/auth.js';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import { clearTokenCache } from '../../src/lib/keychain.js';
import { setKeytarImpl } from '../helpers/mock-keytar.js';
import { setMockUi } from '../../src/ui/index.js';

const HTTP_SCHEME = 'http';
const LOOPBACK_HOST = '127.0.0.1';
const TEST_PORT_A = 64130;
const TEST_PORT_B = 64135;
const PORT_SCAN_DELAY_MS = 150;

function serverUrl(port: number): string {
  return `${HTTP_SCHEME}://${LOOPBACK_HOST}:${port}`;
}

/**
 * Extract port from the auth URL captured by the openBrowser mock
 */
function extractPortFromMockBrowserCall(): number {
  const calls = mockOpenBrowser.mock.calls;
  const lastUrl = calls[calls.length - 1][0];
  return Number.parseInt(new URL(lastUrl).searchParams.get('port') ?? '');
}

// ─── Keychain wrapper functions ──────────────────────────────────────

describe('Auth Scenarios: keychain token management', () => {
  const mockStore = new Map<string, string>();
  const SONARCLOUD_URL = 'https://sonarcloud.io';
  const ONPREM_URL = 'https://sonar.example.com';

  beforeEach(() => {
    mockStore.clear();
    clearTokenCache();
    setKeytarImpl({
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
    setKeytarImpl(null);
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

// ─── generateTokenViaBrowser integration ─────────────────────────────

describe('Auth Scenarios: generateTokenViaBrowser full flow', () => {
  beforeEach(() => {
    mockOpenBrowser.mockClear();
    // Mock UI so pressAnyKeyPrompt resolves immediately without stdin
    setMockUi(true);
  });

  afterEach(() => {
    setMockUi(false);
  });

  it('should complete full OAuth flow: start server, receive POST token, resolve', async () => {
    // Pass mockOpenBrowser directly to bypass CI guard
    const tokenPromise = generateTokenViaBrowser('https://sonarcloud.io', mockOpenBrowser);

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, PORT_SCAN_DELAY_MS));

    const port = extractPortFromMockBrowserCall();

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
    const tokenPromise = generateTokenViaBrowser('https://sonarcloud.io', mockOpenBrowser);

    await new Promise(resolve => setTimeout(resolve, PORT_SCAN_DELAY_MS));

    const port = extractPortFromMockBrowserCall();

    // Simulate SonarQube OAuth callback via GET
    await fetch(`${serverUrl(port)}/?token=squ_get_flow_token`);

    const token = await tokenPromise;
    expect(token).toBe('squ_get_flow_token');
  });
});

// ─── validateToken error handling ────────────────────────────────────

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

// ─── openBrowserWithFallback ──────────────────────────────────────────

describe('Auth Scenarios: openBrowserWithFallback', () => {
  let savedCI: string | undefined;

  beforeEach(() => {
    mockOpenBrowser.mockClear();
    // Remove CI env var so openBrowserWithFallback doesn't short-circuit
    savedCI = process.env['CI'];
    delete process.env['CI'];
  });

  afterEach(() => {
    if (savedCI !== undefined) {
      process.env['CI'] = savedCI;
    }
  });

  it('should call openBrowser with the auth URL', async () => {
    await openBrowserWithFallback('https://sonarcloud.io/test');
    expect(mockOpenBrowser).toHaveBeenCalledWith('https://sonarcloud.io/test');
  });

  it('should not throw when browser opening fails', async () => {
    mockOpenBrowser.mockImplementationOnce(() => Promise.reject(new Error('No browser found')));

    expect(
      openBrowserWithFallback('https://sonarcloud.io/test')
    ).resolves.toBeUndefined();
  });

  it('should skip browser when CI=true', async () => {
    process.env['CI'] = 'true';
    try {
      await openBrowserWithFallback('https://sonarcloud.io/test');
      expect(mockOpenBrowser).not.toHaveBeenCalled();
    } finally {
      delete process.env['CI'];
    }
  });
});

// ─── buildAuthURL correctness ─────────────────────────────────────────

describe('Auth Scenarios: buildAuthURL correctness', () => {
  it('should build auth URL that includes all required parameters', () => {
    const url = buildAuthURL('https://sonarcloud.io', TEST_PORT_A);
    const parsed = new URL(url);

    expect(parsed.hostname).toBe('sonarcloud.io');
    expect(parsed.pathname).toBe('/auth');
    expect(parsed.searchParams.get('product')).toBe('cli');
    expect(parsed.searchParams.get('port')).toBe(String(TEST_PORT_A));
  });

  it('should strip trailing slash from server URL', () => {
    const url = buildAuthURL('https://sonar.example.com/', TEST_PORT_B);
    expect(url).not.toContain('sonar.example.com//');
    expect(url).toContain('sonar.example.com/sonarlint/auth');
  });
});

// ─── validateToken success ────────────────────────────────────────────

describe('Auth Scenarios: validateToken success', () => {
  it('should return true when server responds with valid token', async () => {
    const validateSpy = spyOn(SonarQubeClient.prototype, 'validateToken').mockResolvedValue(true);

    try {
      const result = await validateToken('https://sonarcloud.io', 'squ_valid_token');
      expect(result).toBe(true);
    } finally {
      validateSpy.mockRestore();
    }
  });
});

// ─── getSuccessHTML structure ─────────────────────────────────────────

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

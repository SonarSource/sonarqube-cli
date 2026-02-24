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

import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import {
  extractTokenFromPostBody,
  extractTokenFromQuery,
  buildAuthURL,
  getSuccessHTML,
  generateTokenViaBrowser,
} from '../../src/bootstrap/auth.js';
import { startLoopbackServer } from '../../src/lib/loopback-server.js';
import { setMockUi } from '../../src/ui/index.js';

const SONARCLOUD_SERVER = 'https://sonarcloud.io';
const SONARQUBE_CLOUD_US_SERVER = 'https://sonarqube.us';
const EXAMPLE_SERVER = 'https://sonar.example.com';
const HTTP_STATUS_OK = 200;
const TEST_PORT_A = 8080;
const TEST_PORT_B = 9000;

describe('Auth Helper Functions', () => {
  describe('buildAuthURL', () => {
    it('should build URL with clean server URL (no trailing slash)', () => {
      const url = buildAuthURL(SONARCLOUD_SERVER, TEST_PORT_A);
      expect(url).toBe(`${SONARCLOUD_SERVER}/auth?product=cli&port=${TEST_PORT_A}`);
    });

    it('should build URL and remove trailing slash', () => {
      const url = buildAuthURL(`${SONARCLOUD_SERVER}/`, TEST_PORT_B);
      expect(url).toBe(`${SONARCLOUD_SERVER}/auth?product=cli&port=${TEST_PORT_B}`);
    });

    it('should build URL for SQC US', () => {
      const url = buildAuthURL(`${SONARQUBE_CLOUD_US_SERVER}`, TEST_PORT_B);
      expect(url).toBe(`${SONARQUBE_CLOUD_US_SERVER}/auth?product=cli&port=${TEST_PORT_B}`);
    });

    it('should work with custom server URL', () => {
      const url = buildAuthURL(`${EXAMPLE_SERVER}/`, TEST_PORT_A);
      expect(url).toBe(`${EXAMPLE_SERVER}/sonarlint/auth?ideName=sonarqube-cli&port=${TEST_PORT_A}`);
    });
  });

  describe('getSuccessHTML', () => {
    it('should return valid HTML string', () => {
      const html = getSuccessHTML();
      expect(typeof html).toBe('string');
      expect(html.length).toBeGreaterThan(100);
    });

    it('should contain HTML DOCTYPE', () => {
      const html = getSuccessHTML();
      expect(html).toContain('<!DOCTYPE html>');
    });

    it('should contain success title', () => {
      const html = getSuccessHTML();
      expect(html).toContain('Sonar CLI Authentication');
    });

    it('should contain success message', () => {
      const html = getSuccessHTML();
      expect(html).toContain('Authentication Successful');
    });

    it('should contain description text', () => {
      const html = getSuccessHTML();
      expect(html).toContain('You can close this window and return to the terminal');
    });

    it('should contain closing body and html tags', () => {
      const html = getSuccessHTML();
      expect(html).toContain('</body>');
      expect(html).toContain('</html>');
    });
  });

  describe('extractTokenFromPostBody', () => {
    it('should extract token from valid JSON POST body', () => {
      const body = JSON.stringify({ token: 'squ_valid_token' });
      const token = extractTokenFromPostBody(body);
      expect(token).toBe('squ_valid_token');
    });

    it('should return undefined for missing token field', () => {
      const body = JSON.stringify({ data: 'something' });
      const token = extractTokenFromPostBody(body);
      expect(token).toBeUndefined();
    });

    it('should return undefined for empty token', () => {
      const body = JSON.stringify({ token: '' });
      const token = extractTokenFromPostBody(body);
      expect(token).toBeUndefined();
    });

    it('should return undefined for invalid JSON', () => {
      const token = extractTokenFromPostBody('not json');
      expect(token).toBeUndefined();
    });

    it('should extract token with special characters', () => {
      const tokenValue = 'squ_abc_123!@#$%';
      const body = JSON.stringify({ token: tokenValue });
      const token = extractTokenFromPostBody(body);
      expect(token).toBe(tokenValue);
    });

    it('should return undefined if token is not a string', () => {
      const body = JSON.stringify({ token: 12345 });
      const token = extractTokenFromPostBody(body);
      expect(token).toBeUndefined();
    });

    it('should return undefined if token is null', () => {
      const body = JSON.stringify({ token: null });
      const token = extractTokenFromPostBody(body);
      expect(token).toBeUndefined();
    });

    it('should ignore other JSON fields', () => {
      const body = JSON.stringify({ token: 'squ_test', user: 'john', org: 'acme' });
      const token = extractTokenFromPostBody(body);
      expect(token).toBe('squ_test');
    });
  });

  describe('extractTokenFromQuery', () => {
    it('should extract token from query parameters', () => {
      const token = extractTokenFromQuery('localhost:8080', '/?token=squ_test');
      expect(token).toBe('squ_test');
    });

    it('should return undefined when host is missing', () => {
      const token = extractTokenFromQuery(undefined, '/?token=squ_test');
      expect(token).toBeUndefined();
    });

    it('should return undefined when url is missing', () => {
      const token = extractTokenFromQuery('localhost:8080', undefined);
      expect(token).toBeUndefined();
    });

    it('should return undefined for malformed URL', () => {
      const token = extractTokenFromQuery('localhost:8080', 'not a valid url');
      expect(token).toBeUndefined();
    });

    it('should extract token with multiple query parameters', () => {
      const token = extractTokenFromQuery('localhost:8080', '/?user=john&token=squ_xyz&org=acme');
      expect(token).toBe('squ_xyz');
    });

    it('should return undefined for empty token parameter', () => {
      const token = extractTokenFromQuery('localhost:8080', '/?token=');
      expect(token).toBeUndefined();
    });

    it('should handle URL-encoded tokens', () => {
      const token = extractTokenFromQuery('localhost:8080', '/?token=squ%5Ftest%5F123');
      expect(token).toBe('squ_test_123');
    });

    it('should work with 127.0.0.1', () => {
      const token = extractTokenFromQuery('127.0.0.1:9000', '/?token=squ_local');
      expect(token).toBe('squ_local');
    });

    it('should work with IPv6 loopback', () => {
      const token = extractTokenFromQuery('[::1]:8080', '/?token=squ_ipv6');
      expect(token).toBe('squ_ipv6');
    });
  });
});

// =============================================================================
// CORS preflight — loopback server must allow POST for cross-origin SonarCloud
// =============================================================================
//
// When SonarCloud's page delivers the token, the browser makes a cross-origin
// POST to the loopback server. Browsers always send an OPTIONS preflight first.
// If the preflight response does not include POST in Access-Control-Allow-Methods,
// the browser blocks the actual POST and the token never arrives.
//
// Node.js fetch (used in other tests) does NOT send CORS preflights — only real
// browsers do. This describe block catches that gap.

describe('loopback server CORS preflight', () => {
  it('OPTIONS preflight for SonarCloud origin allows POST in Access-Control-Allow-Methods', async () => {
    const server = await startLoopbackServer(
      (_req, res) => { res.writeHead(HTTP_STATUS_OK); res.end(); },
      { allowedOrigins: ['https://sonarcloud.io'] }
    );
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://sonarcloud.io',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      const allowedMethods = response.headers.get('access-control-allow-methods') ?? '';
      expect(allowedMethods).toContain('POST');
    } finally {
      await server.close();
    }
  });
});

describe('generateTokenViaBrowser', () => {
  beforeEach(() => { setMockUi(true); });
  afterEach(() => { setMockUi(false); });

  // Simulates real browser CORS flow: OPTIONS preflight → POST.
  // If the preflight doesn't allow POST, openBrowserFn throws immediately
  // (fail-fast) rather than silently never delivering the token.
  it('returns token delivered via POST to loopback server (with CORS preflight)', async () => {
    const mockOpenBrowser = async (authURL: string): Promise<void> => {
      const url = new URL(authURL);
      const port = url.searchParams.get('port');

      // Step 1: browser sends preflight before cross-origin POST
      const preflight = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://sonarcloud.io',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      const allowedMethods = preflight.headers.get('access-control-allow-methods') ?? '';
      // Fail fast here — same as browser blocking the POST
      expect(allowedMethods).toContain('POST');

      // Step 2: browser sends actual POST after preflight passes
      setTimeout(() => {
        fetch(`http://127.0.0.1:${port}/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Origin': 'https://sonarcloud.io' },
          body: JSON.stringify({ token: 'squ_test_browser_token' }),
        }).catch(() => {});
      }, 10);
    };

    const token = await generateTokenViaBrowser(SONARCLOUD_SERVER, mockOpenBrowser);
    expect(token).toBe('squ_test_browser_token');
  });

  it('returns token delivered via GET query parameter', async () => {
    const mockOpenBrowser = async (authURL: string): Promise<void> => {
      const url = new URL(authURL);
      const port = url.searchParams.get('port');

      setTimeout(() => {
        fetch(`http://127.0.0.1:${port}/?token=squ_test_get_token`).catch(() => {});
      }, 10);
    };

    const token = await generateTokenViaBrowser(SONARCLOUD_SERVER, mockOpenBrowser);
    expect(token).toBe('squ_test_get_token');
  });
});

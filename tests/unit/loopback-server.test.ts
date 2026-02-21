import { describe, it, expect, afterEach } from 'bun:test';
import { startLoopbackServer, getSecurityHeaders, isValidLoopbackOrigin, isValidLoopbackHost, type LoopbackServerResult } from '../../src/lib/loopback-server.js';
import { AUTH_PORT_START, AUTH_PORT_COUNT } from '../../src/lib/config-constants.js';

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_FORBIDDEN = 403;
const TEST_TIMEOUT_MS = 1000;
const LOOPBACK_HOST = '127.0.0.1';
const HTTP_SCHEME = 'http';
const LOOPBACK_URL_PREFIX = `${HTTP_SCHEME}://${LOOPBACK_HOST}`;
// DNS rebinding test origins (intentionally non-loopback, must be http for origin validation)
const EXTERNAL_ORIGIN = `${HTTP_SCHEME}://evil.com`;
const SONARCLOUD_ORIGIN = 'https://sonarcloud.io';

describe('loopback-server', () => {
  describe('getSecurityHeaders', () => {
    it('should return all required security headers', () => {
      const headers = getSecurityHeaders();

      expect(headers['Content-Security-Policy']).toBe("default-src 'none'; connect-src 'self'");
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['Cache-Control']).toBe('no-store');
    });

  });

  describe('isValidLoopbackOrigin', () => {
    it('should accept localhost origin', () => {
      expect(isValidLoopbackOrigin(`${HTTP_SCHEME}://localhost:8080`)).toBe(true);
    });

    it('should accept 127.0.0.1 origin', () => {
      expect(isValidLoopbackOrigin(`${HTTP_SCHEME}://127.0.0.1:8080`)).toBe(true);
    });

    it('should accept [::1] origin (IPv6 loopback)', () => {
      expect(isValidLoopbackOrigin(`${HTTP_SCHEME}://[::1]:8080`)).toBe(true);
    });

    it('should reject external origins', () => {
      expect(isValidLoopbackOrigin(`${HTTP_SCHEME}://evil.com:8080`)).toBe(false);
      expect(isValidLoopbackOrigin(`${HTTP_SCHEME}://192.168.1.1:8080`)).toBe(false);
      expect(isValidLoopbackOrigin('https://localhost.com')).toBe(false);
    });

    it('should reject malformed origins', () => {
      expect(isValidLoopbackOrigin('not-a-url')).toBe(false);
      expect(isValidLoopbackOrigin('::::')).toBe(false);
      expect(isValidLoopbackOrigin('')).toBe(false);
    });

    it('should accept localhost without port', () => {
      expect(isValidLoopbackOrigin(`${HTTP_SCHEME}://localhost`)).toBe(true);
    });

    it('should be case-insensitive for scheme', () => {
      expect(isValidLoopbackOrigin('HTTP://LOCALHOST:8080')).toBe(true);
      expect(isValidLoopbackOrigin('HTTPS://127.0.0.1:8080')).toBe(true);
    });
  });

  describe('isValidLoopbackHost', () => {
    it('should accept localhost host header', () => {
      expect(isValidLoopbackHost('localhost:8080')).toBe(true);
    });

    it('should accept 127.0.0.1 host header', () => {
      expect(isValidLoopbackHost('127.0.0.1:8080')).toBe(true);
    });

    it('should accept [::1] host header (IPv6 loopback)', () => {
      expect(isValidLoopbackHost('[::1]:8080')).toBe(true);
    });

    it('should accept host without port', () => {
      expect(isValidLoopbackHost('localhost')).toBe(true);
      expect(isValidLoopbackHost('127.0.0.1')).toBe(true);
    });

    it('should reject external host headers', () => {
      expect(isValidLoopbackHost('evil.com:8080')).toBe(false);
      expect(isValidLoopbackHost('192.168.1.1:8080')).toBe(false);
      expect(isValidLoopbackHost('attacker.localhost:8080')).toBe(false);
    });

    it('should reject malformed host headers', () => {
      expect(isValidLoopbackHost('::::')).toBe(false);
      expect(isValidLoopbackHost('')).toBe(false);
    });
  });

  describe('startLoopbackServer', () => {
    let server: LoopbackServerResult | null = null;

    afterEach(async () => {
      if (server) {
        await server.close();
        server = null;
      }
    });

    it('should start a server on a port in the SonarLint range', async () => {
      server = await startLoopbackServer((_req, res) => {
        res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/plain' });
        res.end('OK');
      });

      expect(server.port).toBeGreaterThanOrEqual(AUTH_PORT_START);
      expect(server.port).toBeLessThan(AUTH_PORT_START + AUTH_PORT_COUNT);

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`);
      expect(response.status).toBe(HTTP_STATUS_OK);
    });

    // On macOS, browsers resolve 'localhost' to ::1 (IPv6) before 127.0.0.1 (IPv4).
    // SonarCloud sends the OAuth token via POST to http://localhost:PORT/ — if the
    // server does not bind to ::1, the browser gets ECONNREFUSED and the token never
    // arrives, causing a 50-second hang.
    it('should accept requests from IPv6 loopback [::1]', async () => {
      server = await startLoopbackServer((_req, res) => {
        res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/plain' });
        res.end('OK');
      });

      const response = await fetch(`http://[::1]:${server.port}`);
      expect(response.status).toBe(HTTP_STATUS_OK);
    });

    it('should include security headers in response', async () => {
      server = await startLoopbackServer((_req, res) => {
        res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/plain' });
        res.end('Test');
      });

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`);

      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; connect-src 'self'");
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('should merge user headers with security headers', async () => {
      server = await startLoopbackServer((_req, res) => {
        res.writeHead(HTTP_STATUS_OK, {
          'Content-Type': 'application/json',
          'X-Custom-Header': 'custom-value',
        });
        res.end('{}');
      });

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`);

      // User headers preserved
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(response.headers.get('X-Custom-Header')).toBe('custom-value');
      // Security headers also present
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('should allow user headers to override security headers', async () => {
      server = await startLoopbackServer((_req, res) => {
        res.writeHead(HTTP_STATUS_OK, {
          'Cache-Control': 'max-age=3600',
        });
        res.end('OK');
      });

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`);

      // User override takes precedence
      expect(response.headers.get('Cache-Control')).toBe('max-age=3600');
      // Other security headers still present
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('should reject requests from non-localhost origins', async () => {
      server = await startLoopbackServer((_req, res) => {
        res.writeHead(HTTP_STATUS_OK);
        res.end('OK');
      });

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, {
        method: 'GET',
        headers: { Origin: EXTERNAL_ORIGIN },
      });

      expect(response.status).toBe(HTTP_STATUS_FORBIDDEN);
    });

    it('should reject requests with non-loopback Host header', async () => {
      server = await startLoopbackServer((_req, res) => {
        res.writeHead(HTTP_STATUS_OK);
        res.end('OK');
      });

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, {
        headers: { Host: 'evil.com:8080' },
      });

      expect(response.status).toBe(HTTP_STATUS_FORBIDDEN);
    });

    it('should accept requests with loopback Host header', async () => {
      server = await startLoopbackServer((_req, res) => {
        res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/plain' });
        res.end('OK');
      });

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, {
        headers: { Host: `${LOOPBACK_HOST}:${server.port}` },
      });

      expect(response.status).toBe(HTTP_STATUS_OK);
    });

    it('should accept requests from localhost origins', async () => {
      server = await startLoopbackServer((_req, res) => {
        res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/plain' });
        res.end('OK');
      });

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, {
        headers: { Origin: `${HTTP_SCHEME}://localhost:${server.port}` },
      });

      expect(response.status).toBe(HTTP_STATUS_OK);
    });

    it('should handle OPTIONS preflight requests', async () => {
      server = await startLoopbackServer((_req, res) => {
        res.writeHead(HTTP_STATUS_OK);
        res.end('OK');
      });

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, {
        method: 'OPTIONS',
      });

      expect(response.status).toBe(HTTP_STATUS_OK);
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('should properly close the server', async () => {
      server = await startLoopbackServer((_req, res) => {
        res.writeHead(HTTP_STATUS_OK);
        res.end('OK');
      });

      const { port } = server;
      const response1 = await fetch(`${LOOPBACK_URL_PREFIX}:${port}`);
      expect(response1.status).toBe(HTTP_STATUS_OK);

      await server.close();
      server = null; // Prevent double close in afterEach

      let connectionFailed = false;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
        try {
          await fetch(`${LOOPBACK_URL_PREFIX}:${port}`, { signal: controller.signal });
        } finally {
          clearTimeout(timeoutId);
        }
      } catch {
        connectionFailed = true;
      }

      expect(connectionFailed).toBe(true);
    });

    it('should pass requests to user handler with correct method and URL', async () => {
      let handlerCalls = 0;
      const capturedRequests: { method: string; url: string }[] = [];

      server = await startLoopbackServer((req, res) => {
        handlerCalls++;
        capturedRequests.push({
          method: req.method ?? 'UNKNOWN',
          url: req.url ?? '/',
        });
        res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/plain' });
        res.end(`Call ${handlerCalls}`);
      });

      const response1 = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}/test`);
      expect(response1.status).toBe(HTTP_STATUS_OK);

      const response2 = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}/api`, {
        method: 'POST',
        body: 'test',
      });
      expect(response2.status).toBe(HTTP_STATUS_OK);

      expect(handlerCalls).toBe(2);
      expect(capturedRequests[0].method).toBe('GET');
      expect(capturedRequests[0].url).toBe('/test');
      expect(capturedRequests[1].method).toBe('POST');
      expect(capturedRequests[1].url).toBe('/api');
    });

    it('should handle writeHead called without headers argument', async () => {
      server = await startLoopbackServer((_req, res) => {
        res.writeHead(HTTP_STATUS_OK);
        res.end('no headers');
      });

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`);

      expect(response.status).toBe(HTTP_STATUS_OK);
      // Security headers should still be injected
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('should allow requests from explicitly allowed external origins', async () => {
      server = await startLoopbackServer(
        (_req, res) => {
          res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/plain' });
          res.end('OK');
        },
        { allowedOrigins: [SONARCLOUD_ORIGIN] }
      );

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, {
        headers: { Origin: SONARCLOUD_ORIGIN },
      });

      expect(response.status).toBe(HTTP_STATUS_OK);
    });

    it('should set Access-Control-Allow-Origin header for allowed external origins', async () => {
      server = await startLoopbackServer(
        (_req, res) => {
          res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/plain' });
          res.end('OK');
        },
        { allowedOrigins: [SONARCLOUD_ORIGIN] }
      );

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, {
        headers: { Origin: SONARCLOUD_ORIGIN },
      });

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SONARCLOUD_ORIGIN);
    });

    it('should handle OPTIONS preflight from allowed external origins with CORS headers', async () => {
      server = await startLoopbackServer(
        (_req, res) => {
          res.writeHead(HTTP_STATUS_OK);
          res.end('OK');
        },
        { allowedOrigins: [SONARCLOUD_ORIGIN] }
      );

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, {
        method: 'OPTIONS',
        headers: { Origin: SONARCLOUD_ORIGIN },
      });

      expect(response.status).toBe(HTTP_STATUS_OK);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SONARCLOUD_ORIGIN);
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Private-Network')).toBe('true');
    });

    it('should still reject external origins not in allowedOrigins list', async () => {
      server = await startLoopbackServer(
        (_req, res) => {
          res.writeHead(HTTP_STATUS_OK);
          res.end('OK');
        },
        { allowedOrigins: [SONARCLOUD_ORIGIN] }
      );

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, {
        headers: { Origin: EXTERNAL_ORIGIN },
      });

      expect(response.status).toBe(HTTP_STATUS_FORBIDDEN);
    });
  });
});

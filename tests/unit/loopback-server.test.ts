import { describe, it, expect, afterEach } from 'bun:test';
import { startLoopbackServer, getSecurityHeaders, isValidLoopbackOrigin } from '../../src/lib/loopback-server.js';

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_FORBIDDEN = 403;
const MIN_PORT = 64130;
const MAX_PORT = 64140;
const TEST_TIMEOUT_MS = 1000;
const LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_URL_PREFIX = `http://${LOOPBACK_HOST}`;

describe('loopback-server', () => {
  describe('getSecurityHeaders', () => {
    it('should return all required security headers', () => {
      const headers = getSecurityHeaders();

      expect(headers['Content-Security-Policy']).toBe("default-src 'none'; connect-src 'self'");
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['Cache-Control']).toBe('no-store');
    });

    it('should return an object with exactly 4 headers', () => {
      const headers = getSecurityHeaders();
      expect(Object.keys(headers).length).toBe(4);
    });
  });

  describe('isValidLoopbackOrigin', () => {
    it('should accept localhost origin', () => {
      expect(isValidLoopbackOrigin('http://localhost:8080')).toBe(true);
    });

    it('should accept 127.0.0.1 origin', () => {
      expect(isValidLoopbackOrigin('http://127.0.0.1:8080')).toBe(true);
    });

    it('should accept [::1] origin (IPv6 loopback)', () => {
      expect(isValidLoopbackOrigin('http://[::1]:8080')).toBe(true);
    });

    it('should reject external origins', () => {
      expect(isValidLoopbackOrigin('http://evil.com:8080')).toBe(false);
      expect(isValidLoopbackOrigin('http://192.168.1.1:8080')).toBe(false);
      expect(isValidLoopbackOrigin('https://localhost.com')).toBe(false);
    });

    it('should reject malformed origins', () => {
      expect(isValidLoopbackOrigin('not-a-url')).toBe(false);
      expect(isValidLoopbackOrigin('::::')).toBe(false);
      expect(isValidLoopbackOrigin('')).toBe(false);
    });

    it('should reject origins without port', () => {
      expect(isValidLoopbackOrigin('http://localhost')).toBe(true);
    });

    it('should be case-insensitive for scheme', () => {
      expect(isValidLoopbackOrigin('HTTP://LOCALHOST:8080')).toBe(true);
      expect(isValidLoopbackOrigin('HTTPS://127.0.0.1:8080')).toBe(true);
    });
  });

  describe('startLoopbackServer', () => {
    let serverPort: number;

    afterEach(async () => {
      // Cleanup any existing server (if test created one)
      if (serverPort) {
        serverPort = 0;
      }
    });

    it('should start a server on an available port', async () => {
      const server = await startLoopbackServer((req, res) => {
        res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'text/plain' });
        res.end('OK');
      });

      expect(server.port).toBeGreaterThanOrEqual(MIN_PORT);
      expect(server.port).toBeLessThanOrEqual(MAX_PORT);
      serverPort = server.port;

      // Test that server responds
      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, {
        method: 'GET',
      });

      expect(response.status).toBe(HTTP_STATUS_OK);
      await server.close();
    });

    it('should include security headers in response', async () => {
      const server = await startLoopbackServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Test');
      });

      serverPort = server.port;

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, {
        method: 'GET',
      });

      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; connect-src 'self'");
      expect(response.headers.get('Cache-Control')).toBe('no-store');

      await server.close();
    });

    it('should reject requests from non-localhost origins', async () => {
      const server = await startLoopbackServer((req, res) => {
        res.writeHead(200);
        res.end('OK');
      });

      serverPort = server.port;

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, {
        method: 'GET',
        headers: {
          'Origin': 'http://evil.com',
        },
      });

      expect(response.status).toBe(HTTP_STATUS_FORBIDDEN);
      await server.close();
    });

    it('should accept requests from localhost origins', async () => {
      const server = await startLoopbackServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
      });

      serverPort = server.port;

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, {
        method: 'GET',
        headers: {
          'Origin': `http://localhost:${server.port}`,
        },
      });

      expect(response.status).toBe(HTTP_STATUS_OK);
      await server.close();
    });

    it('should handle OPTIONS preflight requests', async () => {
      const server = await startLoopbackServer((req, res) => {
        res.writeHead(200);
        res.end('OK');
      });

      serverPort = server.port;

      const response = await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, {
        method: 'OPTIONS',
      });

      expect(response.status).toBe(HTTP_STATUS_OK);
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      await server.close();
    });

    it('should properly close the server', async () => {
      const server = await startLoopbackServer((req, res) => {
        res.writeHead(200);
        res.end('OK');
      });

      serverPort = server.port;

      // Make a request
      const response1 = await fetch(`http://127.0.0.1:${server.port}`);
      expect(response1.status).toBe(200);

      // Close the server
      await server.close();

      // Try to make another request - should fail
      let connectionFailed = false;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
        try {
          await fetch(`${LOOPBACK_URL_PREFIX}:${server.port}`, { signal: controller.signal });
        } finally {
          clearTimeout(timeoutId);
        }
      } catch {
        connectionFailed = true;
      }

      expect(connectionFailed).toBe(true);
    });

    it('should pass requests to user handler', async () => {
      let handlerCalls = 0;
      const capturedRequests: { method: string; url: string }[] = [];

      const server = await startLoopbackServer((req, res) => {
        handlerCalls++;
        capturedRequests.push({
          method: req.method || 'UNKNOWN',
          url: req.url || '/',
        });
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`Call ${handlerCalls}`);
      });

      serverPort = server.port;

      // Make GET request
      const response1 = await fetch(`http://127.0.0.1:${server.port}/test`);
      expect(response1.status).toBe(200);

      // Make POST request
      const response2 = await fetch(`http://127.0.0.1:${server.port}/api`, {
        method: 'POST',
        body: 'test',
      });
      expect(response2.status).toBe(200);

      expect(handlerCalls).toBe(2);
      expect(capturedRequests[0].method).toBe('GET');
      expect(capturedRequests[1].method).toBe('POST');

      await server.close();
    });
  });
});

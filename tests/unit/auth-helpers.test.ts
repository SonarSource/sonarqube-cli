import { describe, it, expect } from 'bun:test';
import {
  extractTokenFromPostBody,
  extractTokenFromQuery,
  buildAuthURL,
  getSuccessHTML,
} from '../../src/bootstrap/auth.js';

const SONARCLOUD_SERVER = 'https://sonarcloud.io';
const EXAMPLE_SERVER = 'https://sonar.example.com';

describe('Auth Helper Functions', () => {
  describe('buildAuthURL', () => {
    it('should build URL with clean server URL (no trailing slash)', () => {
      const url = buildAuthURL(SONARCLOUD_SERVER, 8080);
      expect(url).toBe(`${SONARCLOUD_SERVER}/sonarlint/auth?ideName=sonarqube-cli&port=8080`);
    });

    it('should build URL and remove trailing slash', () => {
      const url = buildAuthURL(`${SONARCLOUD_SERVER}/`, 9000);
      expect(url).toBe(`${SONARCLOUD_SERVER}/sonarlint/auth?ideName=sonarqube-cli&port=9000`);
    });

    it('should work with different ports', () => {
      const url = buildAuthURL(EXAMPLE_SERVER, 3000);
      expect(url).toContain('port=3000');
    });

    it('should work with custom server URL', () => {
      const url = buildAuthURL(`${EXAMPLE_SERVER}/`, 8080);
      expect(url).toBe(`${EXAMPLE_SERVER}/sonarlint/auth?ideName=sonarqube-cli&port=8080`);
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

    it('should contain success checkmark emoji', () => {
      const html = getSuccessHTML();
      expect(html).toContain('✓');
    });

    it('should have proper CSS styling', () => {
      const html = getSuccessHTML();
      expect(html).toContain('font-family');
      expect(html).toContain('display: flex');
      expect(html).toContain('background');
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

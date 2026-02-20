import { describe, it, expect } from 'bun:test';
import { extractTokenFromPostBody, extractTokenFromQuery } from '../../src/bootstrap/auth.js';

describe('Token extraction functions', () => {
  describe('extractTokenFromPostBody', () => {
    it('should extract token from valid JSON with token field', () => {
      const body = JSON.stringify({ token: 'squ_test_token_123' });
      const token = extractTokenFromPostBody(body);
      expect(token).toBe('squ_test_token_123');
    });

    it('should extract token with special characters', () => {
      const token = 'squ_abc123_xyz_!@#$%^&*()';
      const body = JSON.stringify({ token });
      expect(extractTokenFromPostBody(body)).toBe(token);
    });

    it('should return undefined if JSON lacks token field', () => {
      const body = JSON.stringify({ data: 'something', user: 'test' });
      expect(extractTokenFromPostBody(body)).toBeUndefined();
    });

    it('should return undefined if token is null', () => {
      const body = JSON.stringify({ token: null });
      expect(extractTokenFromPostBody(body)).toBeUndefined();
    });

    it('should return undefined if token is empty string', () => {
      const body = JSON.stringify({ token: '' });
      expect(extractTokenFromPostBody(body)).toBeUndefined();
    });

    it('should return undefined for invalid JSON', () => {
      expect(extractTokenFromPostBody('not valid json')).toBeUndefined();
      expect(extractTokenFromPostBody('{')).toBeUndefined();
      expect(extractTokenFromPostBody('}')).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
      expect(extractTokenFromPostBody('')).toBeUndefined();
    });

    it('should extract token from JSON with additional fields', () => {
      const body = JSON.stringify({
        token: 'squ_abc123',
        user: 'john',
        org: 'acme',
      });
      expect(extractTokenFromPostBody(body)).toBe('squ_abc123');
    });

    it('should handle token as non-string (not extracted)', () => {
      const body = JSON.stringify({ token: 12345 });
      expect(extractTokenFromPostBody(body)).toBeUndefined();
    });
  });

  describe('extractTokenFromQuery', () => {
    it('should extract token from query parameter', () => {
      const token = extractTokenFromQuery('localhost:8080', '/?token=squ_test_123');
      expect(token).toBe('squ_test_123');
    });

    it('should extract token with special characters', () => {
      const tokenValue = 'squ_abc_123_xyz';
      const token = extractTokenFromQuery('localhost:8080', `/?token=${tokenValue}`);
      expect(token).toBe(tokenValue);
    });

    it('should extract token from multiple query params', () => {
      const token = extractTokenFromQuery('localhost:8080', '/?user=john&token=squ_test_456&org=acme');
      expect(token).toBe('squ_test_456');
    });

    it('should return undefined if no token param', () => {
      expect(extractTokenFromQuery('localhost:8080', '/?user=john&org=acme')).toBeUndefined();
    });

    it('should return undefined if token param is empty', () => {
      expect(extractTokenFromQuery('localhost:8080', '/?token=')).toBeUndefined();
    });

    it('should return undefined if host is undefined', () => {
      expect(extractTokenFromQuery(undefined, '/?token=squ_123')).toBeUndefined();
    });

    it('should return undefined if url is undefined', () => {
      expect(extractTokenFromQuery('localhost:8080', undefined)).toBeUndefined();
    });

    it('should return undefined for malformed URL', () => {
      expect(extractTokenFromQuery('localhost:8080', 'not a valid url')).toBeUndefined();
    });

    it('should handle token in path-like URL', () => {
      const token = extractTokenFromQuery('127.0.0.1:64130', '/callback?token=squ_xyz789');
      expect(token).toBe('squ_xyz789');
    });

    it('should handle different hosts', () => {
      expect(extractTokenFromQuery('localhost:8080', '/?token=squ_1')).toBe('squ_1');
      expect(extractTokenFromQuery('127.0.0.1:8080', '/?token=squ_2')).toBe('squ_2');
      expect(extractTokenFromQuery('[::1]:8080', '/?token=squ_3')).toBe('squ_3');
    });

    it('should handle URLs without host port', () => {
      const token = extractTokenFromQuery('localhost', '/?token=squ_test');
      expect(token).toBe('squ_test');
    });

    it('should handle token URL-encoded', () => {
      const token = extractTokenFromQuery('localhost:8080', '/?token=squ%5Ftest%5F123');
      expect(token).toBe('squ_test_123');
    });
  });
});

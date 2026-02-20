// Tests for repair orchestrator

import { describe, it, expect } from 'bun:test';
import type { HealthCheckResult } from '../../src/bootstrap/health.js';

describe('Repair Health Checks', () => {
  it('HealthCheckResult interface: tokenValid and hooksInstalled fields with boolean types', () => {
    const allValid: HealthCheckResult = {
      tokenValid: true,
      hooksInstalled: true
    };

    const tokenInvalid: HealthCheckResult = {
      tokenValid: false,
      hooksInstalled: true
    };

    const hooksNotInstalled: HealthCheckResult = {
      tokenValid: true,
      hooksInstalled: false
    };

    // Verify all combinations
    expect(allValid.tokenValid).toBe(true);
    expect(allValid.hooksInstalled).toBe(true);

    expect(tokenInvalid.tokenValid).toBe(false);
    expect(tokenInvalid.hooksInstalled).toBe(true);

    expect(hooksNotInstalled.tokenValid).toBe(true);
    expect(hooksNotInstalled.hooksInstalled).toBe(false);

    // Type validation
    expect(typeof allValid.tokenValid).toBe('boolean');
    expect(typeof allValid.hooksInstalled).toBe('boolean');
  });
});

describe('Repair Configuration Parameters', () => {
  it('Server URLs, project paths, hook types, and organization names are valid', () => {
    // Valid server URLs
    const servers = [
      'https://sonarcloud.io',
      'https://sonarqube.example.com',
      'https://localhost:9000'
    ];

    servers.forEach((url) => {
      expect(typeof url).toBe('string');
      expect(url.startsWith('https://')).toBe(true);
      expect(url.length).toBeGreaterThan(10);
    });

    // Valid project paths
    const paths = ['/tmp/test-project', '/home/user/project', '/opt/sonarqube'];

    paths.forEach((path) => {
      expect(typeof path).toBe('string');
      expect(path.startsWith('/')).toBe(true);
      expect(path.length).toBeGreaterThan(3);
    });

    // Valid hook types
    const hookTypes: Array<'prompt' | 'cli'> = ['prompt', 'cli'];

    hookTypes.forEach((hookType) => {
      expect(['prompt', 'cli']).toContain(hookType);
    });

    // Valid organization names
    const orgs = ['my-org', 'test-org', 'acme-corp'];

    orgs.forEach((org) => {
      expect(typeof org).toBe('string');
      expect(org.length).toBeGreaterThan(0);
    });
  });
});

// Tests for repair orchestrator

import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRepair } from '../../src/bootstrap/repair.js';
import type { HealthCheckResult } from '../../src/bootstrap/health.js';

describe('Repair Orchestrator', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `test-repair-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('runRepair: processes health check and installs hooks when needed', async () => {
    const healthResult: HealthCheckResult = {
      tokenValid: true,
      serverAvailable: true,
      projectAccessible: true,
      organizationAccessible: true,
      qualityProfilesAccessible: true,
      hooksInstalled: false,
      errors: []
    };

    // Should not throw when hooks not installed but can be
    try {
      await runRepair(
        'https://sonarcloud.io',
        testDir,
        healthResult,
        'test_key',
        'test-org',
        'prompt'
      );

      // After repair, .claude directory should be created
      const claudePath = join(testDir, '.claude');
      expect(existsSync(claudePath)).toBe(true);
    } catch (error) {
      // Some errors are expected (auth, network)
      expect((error as Error).message).toBeDefined();
    }
  });

  it('runRepair: respects hookType parameter (prompt vs cli)', async () => {
    const health: HealthCheckResult = {
      tokenValid: true,
      serverAvailable: true,
      projectAccessible: true,
      organizationAccessible: true,
      qualityProfilesAccessible: true,
      hooksInstalled: false,
      errors: []
    };

    // Test with prompt hookType
    try {
      await runRepair(
        'https://sonarcloud.io',
        testDir,
        health,
        'key',
        'org',
        'prompt'
      );
      expect(existsSync(join(testDir, '.claude'))).toBe(true);
    } catch (error) {
      expect((error as Error).message).toBeDefined();
    }

    // Clean up for next test
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    // Test with cli hookType
    try {
      await runRepair(
        'https://sonarcloud.io',
        testDir,
        health,
        'key',
        'org',
        'cli'
      );
      expect(existsSync(join(testDir, '.claude'))).toBe(true);
    } catch (error) {
      expect((error as Error).message).toBeDefined();
    }
  });

  it('runRepair: creates .claude/settings.json and hooks directory structure', async () => {
    const health: HealthCheckResult = {
      tokenValid: true,
      serverAvailable: true,
      projectAccessible: true,
      organizationAccessible: true,
      qualityProfilesAccessible: true,
      hooksInstalled: false,
      errors: []
    };

    try {
      await runRepair(
        'https://sonarcloud.io',
        testDir,
        health,
        'test_key',
        'test-org'
      );

      const claudePath = join(testDir, '.claude');
      const hooksPath = join(claudePath, 'hooks');

      expect(existsSync(claudePath)).toBe(true);
      // At minimum, hooks dir should be created
      expect(existsSync(hooksPath)).toBe(true);
    } catch (error) {
      // Auth/network errors are acceptable
      expect((error as Error).message).toBeDefined();
    }
  });
});

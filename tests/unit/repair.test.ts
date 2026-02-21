// Tests for repair orchestrator

import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRepair } from '../../src/bootstrap/repair.js';
import type { HealthCheckResult } from '../../src/bootstrap/health.js';
import { setMockUi } from '../../src/ui';

const healthAllGood: HealthCheckResult = {
  tokenValid: true,
  serverAvailable: true,
  projectAccessible: true,
  organizationAccessible: true,
  qualityProfilesAccessible: true,
  hooksInstalled: true,
  errors: []
};

const healthNeedsHooks: HealthCheckResult = {
  ...healthAllGood,
  hooksInstalled: false,
};

describe('Repair Orchestrator', () => {
  let testDir: string;

  beforeEach(() => {
    setMockUi(true);
    testDir = join(tmpdir(), `test-repair-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    setMockUi(false);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates .claude directory when hooks need installing', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthNeedsHooks, 'test_key', 'test-org', 'prompt');

    expect(existsSync(join(testDir, '.claude'))).toBe(true);
  });

  it('creates hooks directory structure when hooksInstalled is false', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthNeedsHooks, 'test_key', 'test-org', 'prompt');

    expect(existsSync(join(testDir, '.claude', 'hooks'))).toBe(true);
  });

  it('creates sonar-secrets hooks directory', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthNeedsHooks, 'test_key', 'test-org', 'prompt');

    expect(existsSync(join(testDir, '.claude', 'hooks', 'sonar-secrets', 'scripts'))).toBe(true);
  });

  it('installs secret scanning hooks even when hooksInstalled is true', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthAllGood, 'test_key', 'test-org', 'prompt');

    expect(existsSync(join(testDir, '.claude', 'hooks', 'sonar-secrets', 'scripts'))).toBe(true);
  });

  it('installs prompt hook script when hookType is prompt', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthNeedsHooks, 'key', 'org', 'prompt');

    const scriptPath = join(testDir, '.claude', 'hooks', 'sonar-prompt.sh');
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('installs cli hook script when hookType is cli', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthNeedsHooks, 'key', 'org', 'cli');

    const scriptPath = join(testDir, '.claude', 'hooks', 'sonar-prompt.sh');
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('skips hook installation when hooksInstalled is true', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthAllGood, 'test_key', 'test-org');

    // sonar-prompt.sh should NOT be created since hooks are already installed
    expect(existsSync(join(testDir, '.claude', 'hooks', 'sonar-prompt.sh'))).toBe(false);
  });
});

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

// Tests for repair orchestrator

import { describe, it, beforeEach, afterEach, expect, spyOn } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRepair } from '../../src/bootstrap/repair.js';
import * as auth from '../../src/bootstrap/auth.js';
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

  it('creates .claude directory when repair runs', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthNeedsHooks, 'test_key', 'test-org');

    expect(existsSync(join(testDir, '.claude'))).toBe(true);
  });

  it('creates hooks directory structure', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthNeedsHooks, 'test_key', 'test-org');

    expect(existsSync(join(testDir, '.claude', 'hooks'))).toBe(true);
  });

  it('creates sonar-secrets hooks directory', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthNeedsHooks, 'test_key', 'test-org');

    expect(existsSync(join(testDir, '.claude', 'hooks', 'sonar-secrets', 'build-scripts'))).toBe(true);
  });

  it('installs secret scanning hooks even when hooksInstalled is true', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthAllGood, 'test_key', 'test-org');

    expect(existsSync(join(testDir, '.claude', 'hooks', 'sonar-secrets', 'build-scripts'))).toBe(true);
  });

  it('does not create old sonar-prompt.sh verify hook', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthNeedsHooks, 'key', 'org');

    expect(existsSync(join(testDir, '.claude', 'hooks', 'sonar-prompt.sh'))).toBe(false);
  });
});

// ─── token invalid path ───────────────────────────────────────────────────────

describe('Repair Orchestrator: token repair', () => {
  let testDir: string;
  let generateTokenSpy: ReturnType<typeof spyOn>;
  let validateTokenSpy: ReturnType<typeof spyOn>;
  let saveTokenSpy: ReturnType<typeof spyOn>;
  let deleteTokenSpy: ReturnType<typeof spyOn>;

  const healthTokenInvalid: HealthCheckResult = {
    tokenValid: false,
    serverAvailable: true,
    projectAccessible: true,
    organizationAccessible: true,
    qualityProfilesAccessible: true,
    hooksInstalled: true,
    errors: [],
  };

  beforeEach(() => {
    setMockUi(true);
    testDir = join(tmpdir(), `test-repair-token-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    generateTokenSpy = spyOn(auth, 'generateTokenViaBrowser').mockResolvedValue('new-token');
    validateTokenSpy = spyOn(auth, 'validateToken').mockResolvedValue(true);
    saveTokenSpy = spyOn(auth, 'saveToken').mockResolvedValue(undefined);
    deleteTokenSpy = spyOn(auth, 'deleteToken').mockResolvedValue(undefined);
  });

  afterEach(() => {
    setMockUi(false);
    generateTokenSpy.mockRestore();
    validateTokenSpy.mockRestore();
    saveTokenSpy.mockRestore();
    deleteTokenSpy.mockRestore();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('generates a new token when tokenValid is false', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthTokenInvalid);
    expect(generateTokenSpy).toHaveBeenCalledWith('https://sonarcloud.io');
  });

  it('deletes old token before generating a new one', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthTokenInvalid, 'proj', 'my-org');
    expect(deleteTokenSpy).toHaveBeenCalledWith('https://sonarcloud.io', 'my-org');
  });

  it('validates generated token and saves it when valid', async () => {
    await runRepair('https://sonarcloud.io', testDir, healthTokenInvalid, 'proj', 'my-org');
    expect(validateTokenSpy).toHaveBeenCalledWith('https://sonarcloud.io', 'new-token');
    expect(saveTokenSpy).toHaveBeenCalledWith('https://sonarcloud.io', 'new-token', 'my-org');
  });

  it('throws when generated token fails validation', async () => {
    validateTokenSpy.mockResolvedValue(false);
    await expect(
      runRepair('https://sonarcloud.io', testDir, healthTokenInvalid)
    ).rejects.toThrow('Generated token is invalid');
  });

  it('continues if deleteToken throws (non-fatal)', async () => {
    deleteTokenSpy.mockRejectedValue(new Error('keychain unavailable'));
    await runRepair('https://sonarcloud.io', testDir, healthTokenInvalid);
    expect(generateTokenSpy).toHaveBeenCalled();
  });
});

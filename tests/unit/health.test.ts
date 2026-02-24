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

// Unit tests for bootstrap/health.ts — runHealthChecks

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { runHealthChecks } from '../../src/bootstrap/health.js';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import * as auth from '../../src/bootstrap/auth.js';
import * as hooks from '../../src/bootstrap/hooks.js';
import { setMockUi } from '../../src/ui';

const SERVER = 'https://sonarcloud.io';
const TOKEN = 'squ_test';
const PROJECT = 'my-project';
const ROOT = '/fake/root';
const ORG = 'my-org';

describe('runHealthChecks: all checks pass', () => {
  let validateSpy: ReturnType<typeof spyOn>;
  let statusSpy: ReturnType<typeof spyOn>;
  let componentSpy: ReturnType<typeof spyOn>;
  let orgSpy: ReturnType<typeof spyOn>;
  let profilesSpy: ReturnType<typeof spyOn>;
  let hooksSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    validateSpy = spyOn(auth, 'validateToken').mockResolvedValue(true);
    statusSpy = spyOn(SonarQubeClient.prototype, 'getSystemStatus').mockResolvedValue({ status: 'UP', version: '1.0' });
    componentSpy = spyOn(SonarQubeClient.prototype, 'checkComponent').mockResolvedValue(true);
    orgSpy = spyOn(SonarQubeClient.prototype, 'checkOrganization').mockResolvedValue(true);
    profilesSpy = spyOn(SonarQubeClient.prototype, 'checkQualityProfiles').mockResolvedValue(true);
    hooksSpy = spyOn(hooks, 'areHooksInstalled').mockResolvedValue(true);
  });

  afterEach(() => {
    validateSpy.mockRestore();
    statusSpy.mockRestore();
    componentSpy.mockRestore();
    orgSpy.mockRestore();
    profilesSpy.mockRestore();
    hooksSpy.mockRestore();
    setMockUi(false);
  });

  it('returns all true fields when every check passes', async () => {
    const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT, ORG);
    expect(result.tokenValid).toBe(true);
    expect(result.serverAvailable).toBe(true);
    expect(result.projectAccessible).toBe(true);
    expect(result.organizationAccessible).toBe(true);
    expect(result.qualityProfilesAccessible).toBe(true);
    expect(result.hooksInstalled).toBe(true);
  });

  it('returns empty errors array when all checks pass', async () => {
    const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT, ORG);
    expect(result.errors).toHaveLength(0);
  });

  it('skips organization check when org is not provided', async () => {
    const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
    expect(orgSpy).not.toHaveBeenCalled();
    expect(result.organizationAccessible).toBe(true);
  });
});

describe('runHealthChecks: individual failures', () => {
  let validateSpy: ReturnType<typeof spyOn>;
  let statusSpy: ReturnType<typeof spyOn>;
  let componentSpy: ReturnType<typeof spyOn>;
  let orgSpy: ReturnType<typeof spyOn>;
  let profilesSpy: ReturnType<typeof spyOn>;
  let hooksSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    validateSpy = spyOn(auth, 'validateToken').mockResolvedValue(true);
    statusSpy = spyOn(SonarQubeClient.prototype, 'getSystemStatus').mockResolvedValue({ status: 'UP', version: '1.0' });
    componentSpy = spyOn(SonarQubeClient.prototype, 'checkComponent').mockResolvedValue(true);
    orgSpy = spyOn(SonarQubeClient.prototype, 'checkOrganization').mockResolvedValue(true);
    profilesSpy = spyOn(SonarQubeClient.prototype, 'checkQualityProfiles').mockResolvedValue(true);
    hooksSpy = spyOn(hooks, 'areHooksInstalled').mockResolvedValue(true);
  });

  afterEach(() => {
    validateSpy.mockRestore();
    statusSpy.mockRestore();
    componentSpy.mockRestore();
    orgSpy.mockRestore();
    profilesSpy.mockRestore();
    hooksSpy.mockRestore();
    setMockUi(false);
  });

  it('tokenValid=false and error added when token is invalid', async () => {
    validateSpy.mockResolvedValue(false);
    const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
    expect(result.tokenValid).toBe(false);
    expect(result.errors.some(e => e.includes('Token'))).toBe(true);
  });

  it('serverAvailable=false when getSystemStatus throws', async () => {
    statusSpy.mockRejectedValue(new Error('connection refused'));
    const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
    expect(result.serverAvailable).toBe(false);
    expect(result.errors.some(e => e.includes('Server'))).toBe(true);
  });

  it('projectAccessible=false when checkComponent returns false', async () => {
    componentSpy.mockResolvedValue(false);
    const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
    expect(result.projectAccessible).toBe(false);
    expect(result.errors.some(e => e.includes(PROJECT))).toBe(true);
  });

  it('organizationAccessible=false when checkOrganization returns false', async () => {
    orgSpy.mockResolvedValue(false);
    const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT, ORG);
    expect(result.organizationAccessible).toBe(false);
    expect(result.errors.some(e => e.includes(ORG))).toBe(true);
  });

  it('qualityProfilesAccessible=false when checkQualityProfiles returns false', async () => {
    profilesSpy.mockResolvedValue(false);
    const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
    expect(result.qualityProfilesAccessible).toBe(false);
    expect(result.errors.some(e => e.toLowerCase().includes('quality'))).toBe(true);
  });

  it('hooksInstalled=false when areHooksInstalled returns false', async () => {
    hooksSpy.mockResolvedValue(false);
    const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
    expect(result.hooksInstalled).toBe(false);
    expect(result.errors.some(e => e.includes('Hooks'))).toBe(true);
  });
});

describe('runHealthChecks: multiple failures collect all errors', () => {
  let validateSpy: ReturnType<typeof spyOn>;
  let statusSpy: ReturnType<typeof spyOn>;
  let componentSpy: ReturnType<typeof spyOn>;
  let profilesSpy: ReturnType<typeof spyOn>;
  let hooksSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    validateSpy = spyOn(auth, 'validateToken').mockResolvedValue(false);
    statusSpy = spyOn(SonarQubeClient.prototype, 'getSystemStatus').mockRejectedValue(new Error('down'));
    componentSpy = spyOn(SonarQubeClient.prototype, 'checkComponent').mockResolvedValue(false);
    profilesSpy = spyOn(SonarQubeClient.prototype, 'checkQualityProfiles').mockResolvedValue(false);
    hooksSpy = spyOn(hooks, 'areHooksInstalled').mockResolvedValue(false);
  });

  afterEach(() => {
    validateSpy.mockRestore();
    statusSpy.mockRestore();
    componentSpy.mockRestore();
    profilesSpy.mockRestore();
    hooksSpy.mockRestore();
    setMockUi(false);
  });

  it('collects all errors when multiple checks fail', async () => {
    const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  it('all boolean fields are false when checks fail', async () => {
    const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT);
    expect(result.tokenValid).toBe(false);
    expect(result.serverAvailable).toBe(false);
    expect(result.projectAccessible).toBe(false);
    expect(result.hooksInstalled).toBe(false);
  });
});

describe('runHealthChecks: verbose=false', () => {
  let validateSpy: ReturnType<typeof spyOn>;
  let statusSpy: ReturnType<typeof spyOn>;
  let componentSpy: ReturnType<typeof spyOn>;
  let profilesSpy: ReturnType<typeof spyOn>;
  let hooksSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    validateSpy = spyOn(auth, 'validateToken').mockResolvedValue(true);
    statusSpy = spyOn(SonarQubeClient.prototype, 'getSystemStatus').mockResolvedValue({ status: 'UP', version: '1.0' });
    componentSpy = spyOn(SonarQubeClient.prototype, 'checkComponent').mockResolvedValue(true);
    profilesSpy = spyOn(SonarQubeClient.prototype, 'checkQualityProfiles').mockResolvedValue(true);
    hooksSpy = spyOn(hooks, 'areHooksInstalled').mockResolvedValue(true);
  });

  afterEach(() => {
    validateSpy.mockRestore();
    statusSpy.mockRestore();
    componentSpy.mockRestore();
    profilesSpy.mockRestore();
    hooksSpy.mockRestore();
    setMockUi(false);
  });

  it('still returns correct results when verbose=false', async () => {
    const result = await runHealthChecks(SERVER, TOKEN, PROJECT, ROOT, undefined, false);
    expect(result.tokenValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

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

// Integration tests for `sonar install secrets` — NO AUTH required

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestHarness } from '../../harness';

describe('install secrets (download)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with error when the binaries server returns 404',
    async () => {
      await harness.newFakeBinariesServer().noArtifacts().start();

      const result = await harness.run('install secrets');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Download failed');
      expect(harness.cliHome.file('bin', 'sonar-secrets').exists()).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'downloads and installs the binary from the mock binaries server',
    async () => {
      const fakeBinariesServer = await harness.newFakeBinariesServer().start();

      const result = await harness.run('install secrets');

      // The binary download request must have gone to the mock server, not the real one
      const requests = fakeBinariesServer.getRecordedRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe('GET');
      expect(requests[0].path).toContain('/CommercialDistribution/sonar-secrets/');
      expect(requests[0].path).toContain('sonar-secrets-');

      // The real binary is served, so signature verification passes and installation succeeds
      expect(result.exitCode).toBe(0);
      expect(harness.cliHome.file('bin', 'sonar-secrets').exists()).toBe(true);
    },
    { timeout: 30000 },
  );
});

describe('install secrets --status', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'reports not installed when sonar-secrets binary is absent',
    async () => {
      // No withSecretsBinaryInstalled() — binary is not present
      const result = await harness.run('install secrets --status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Not installed');
    },
    { timeout: 15000 },
  );

  it(
    'reports installed when sonar-secrets binary is present',
    async () => {
      harness.state().withSecretsBinaryInstalled();

      const result = await harness.run('install secrets --status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Installed');
    },
    { timeout: 15000 },
  );
});

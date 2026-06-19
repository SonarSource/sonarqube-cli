/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
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

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { IS_WINDOWS, TestHarness } from '../../harness';

const PROJECT_ROOT = join(import.meta.dir, '../../../..');
const NEWER_VERSION = '99.0.0';

function buildHomebrewBinary(): { binaryPath: string; tempDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), 'sonar-cli-homebrew-distribution-'));
  const binaryPath = join(
    tempDir,
    IS_WINDOWS ? 'sonarqube-cli-homebrew.exe' : 'sonarqube-cli-homebrew',
  );

  const result = spawnSync(process.execPath, ['build-scripts/build-binary.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      SONARQUBE_CLI_DISTRIBUTION: 'homebrew',
      SONARQUBE_CLI_OUTFILE: binaryPath,
    },
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const logs = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(logs || 'Failed to build homebrew binary');
  }

  return { binaryPath, tempDir };
}

describe('self-update distribution gating', () => {
  let harness: TestHarness;
  let homebrewBinaryPath: string;
  let homebrewBuildDir: string;

  beforeAll(() => {
    const build = buildHomebrewBinary();
    homebrewBinaryPath = build.binaryPath;
    homebrewBuildDir = build.tempDir;
  });

  afterAll(() => {
    rmSync(homebrewBuildDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'keeps self-update available on the standalone build',
    async () => {
      const helpResult = await harness.run('-h');
      expect(helpResult.exitCode).toBe(0);
      expect(helpResult.stdout).toContain('self-update');

      const commandHelp = await harness.run('self-update --help');
      expect(commandHelp.exitCode).toBe(0);
      expect(commandHelp.stdout).toContain('Usage: sonar self-update');
      expect(commandHelp.stdout).toContain('--status');
    },
    { timeout: 15000 },
  );

  it(
    'removes self-update from homebrew builds',
    async () => {
      harness.newFakeUpdateScriptServer(NEWER_VERSION);

      const helpResult = await harness.run('-h', { binaryPath: homebrewBinaryPath });
      expect(helpResult.exitCode).toBe(0);
      expect(helpResult.stdout).not.toContain('self-update');

      const updateStatus = await harness.run('self-update', {
        binaryPath: homebrewBinaryPath,
      });
      expect(updateStatus.exitCode).toBe(1);

      const systemStatus = await harness.run('system status', {
        binaryPath: homebrewBinaryPath,
      });
      expect(systemStatus.exitCode).toBe(0);
      expect(systemStatus.stdout).not.toContain('sonar self-update');
    },
    { timeout: 15000 },
  );
});

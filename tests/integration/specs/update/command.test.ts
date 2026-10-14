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

// Integration tests for the `sonar update` command and the deprecated `sonar self-update` alias

import { chmodSync, copyFileSync, mkdirSync, symlinkSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { version as CLI_VERSION } from '../../../../package.json';
import { IS_WINDOWS, TestHarness } from '../../harness';
import { getCliBinaryPath } from '../../harness/cli-runner.js';

describe('update command', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'sonar update --status reports an available update and warns that the flag is deprecated',
    async () => {
      const newerVersion = '99.0.0';
      await harness.newFakeBinariesServer().withStableVersion(newerVersion).start();

      const result = await harness.run('update --status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(`Update available: v${newerVersion}`);
      expect(result.stderr).toContain(
        "'--status' is deprecated since 1.9 and will be removed in a future version. Use 'sonar update status' instead.",
      );
    },
    { timeout: 15000 },
  );

  it(
    'sonar update status reports an available update without a deprecation warning',
    async () => {
      const newerVersion = '99.0.0';
      await harness.newFakeBinariesServer().withStableVersion(newerVersion).start();

      const result = await harness.run('update status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(`Update available: v${newerVersion}`);
      expect(result.stdout + result.stderr).toContain(
        'Update it through your organization, package manager, or the method used to install it.',
      );
      expect(result.stderr).not.toContain('deprecated');
    },
    { timeout: 15000 },
  );

  it(
    'sonar update status --format json prints a pure JSON payload',
    async () => {
      const newerVersion = '99.0.0';
      await harness.newFakeBinariesServer().withStableVersion(newerVersion).start();

      const result = await harness.run('update status --format json');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        currentVersion: CLI_VERSION,
        latestVersion: newerVersion,
        upToDate: false,
      });
    },
    { timeout: 15000 },
  );

  it(
    'sonar update status --format xml is rejected',
    async () => {
      const result = await harness.run('update status --format xml');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "option '--format <format>' argument 'xml' is invalid",
      );
    },
    { timeout: 15000 },
  );

  it.each(['update', 'update --force', 'self-update'])(
    '%s rejects a binary outside the standalone installer path',
    async (command) => {
      const result = await harness.run(command);

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'This CLI installation cannot be updated by sonar update.',
      );
      expect(result.stdout + result.stderr).toContain(
        'Update it through your organization, package manager, or the method used to install it.',
      );
    },
  );

  it.skipIf(IS_WINDOWS)('accepts an installer binary through a symlinked .local', async () => {
    const realLocal = harness.userHome.dir('real-local');
    const binaryPath = realLocal.file('share', 'sonarqube-cli', 'bin', 'sonar').path;
    mkdirSync(realLocal.dir('share', 'sonarqube-cli', 'bin').path, { recursive: true });
    copyFileSync(getCliBinaryPath(), binaryPath);
    chmodSync(binaryPath, 0o755);
    symlinkSync(realLocal.path, harness.userHome.dir('.local').path, 'dir');
    await harness.newFakeBinariesServer().withStableVersion(CLI_VERSION).start();

    const result = await harness.run('update', { binaryPath });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Already up to date');
  });

  it.skipIf(IS_WINDOWS)('rejects an installer-path link to an external binary', async () => {
    const externalBinary = harness.userHome.file('managed-sonar').path;
    const installDir = harness.userHome.dir('.local', 'share', 'sonarqube-cli', 'bin');
    mkdirSync(installDir.path, { recursive: true });
    copyFileSync(getCliBinaryPath(), externalBinary);
    chmodSync(externalBinary, 0o755);
    symlinkSync(externalBinary, installDir.file('sonar').path);

    const result = await harness.run('update', { binaryPath: installDir.file('sonar').path });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      'This CLI installation cannot be updated by sonar update.',
    );
  });

  it('recommends sonar update from the installer path', async () => {
    await harness.newFakeBinariesServer().withStableVersion('99.0.0').start();

    const result = await harness.run('update status', {
      binaryPath: harness.installerManagedBinaryPath(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Run: sonar update');
  });

  it(
    'sonar self-update --status still works but warns that it is deprecated',
    async () => {
      const newerVersion = '99.0.0';
      await harness.newFakeBinariesServer().withStableVersion(newerVersion).start();

      const result = await harness.run('self-update --status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(`Update available: v${newerVersion}`);
      expect(result.stderr).toContain(
        "'sonar self-update' is deprecated since 1.4 and will be removed in a future version. Use 'sonar update' instead.",
      );
    },
    { timeout: 15000 },
  );

  describe.skipIf(IS_WINDOWS)('standalone Unix installer', () => {
    it.each(['update', 'self-update'])(
      'sonar %s installs a fake executable',
      async (command) => {
        const newerVersion = '99.0.0';
        await harness.newFakeBinariesServer().withStableVersion(newerVersion).start();
        const updateServer = harness.newFakeUpdateScriptServer(newerVersion);
        const installDir = harness.userHome.dir('.local', 'share', 'sonarqube-cli', 'bin');
        mkdirSync(installDir.path, { recursive: true });
        const executable = installDir.file('sonar');
        copyFileSync(getCliBinaryPath(), executable.path);
        chmodSync(executable.path, 0o755);

        const result = await harness.run(command, { binaryPath: executable.path });

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain(`Updated to v${newerVersion}`);
        expect(updateServer.getRequestedPaths()).toEqual(['/install.sh', '/fake-executable']);

        expect(executable.exists()).toBe(true);
        expect(executable.isExecutable).toBe(true);
        const installed = Bun.spawnSync([executable.path]);
        expect(installed.exitCode).toBe(0);
        expect(installed.stdout.toString().trim()).toBe(`fake sonar v${newerVersion}`);
      },
      { timeout: 15000 },
    );
  });
});

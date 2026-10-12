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

import { chmodSync, existsSync, readlinkSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { TestHarness } from '../../harness';
import {
  isRealCli,
  isRoot,
  isStub,
  isSymlink,
  MdmSandbox,
  modeOf,
  SKIP_ON_UNIX,
  SKIP_ON_WINDOWS,
} from './mdm-sandbox';

setDefaultTimeout(60_000);

describe('mdm install', () => {
  let harness: TestHarness;
  let sandbox: MdmSandbox;

  beforeEach(async () => {
    harness = await TestHarness.create();
    sandbox = new MdmSandbox(harness);
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function installedVersion(binaryPath = sandbox.binaryPath): Promise<string> {
    return (await harness.run('--version', { binaryPath })).stdout;
  }

  it('copies the running CLI to the system path and the copy runs', async () => {
    const reference = await harness.run('--version');

    const result = await sandbox.run('install');

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain(sandbox.binaryPath);
    expect(isRealCli(sandbox.binaryPath)).toBe(true);
    expect(await installedVersion()).toBe(reference.stdout);
  });

  it.skipIf(SKIP_ON_WINDOWS)('installs with mode 755', async () => {
    await sandbox.run('install');

    expect(modeOf(sandbox.binaryPath)).toBe(0o755);
  });

  it.skipIf(SKIP_ON_WINDOWS)(
    'replaces existing standalone installs with symlinks and leaves users without one alone',
    async () => {
      const standalone = sandbox.seedStandalone(0);

      const result = await sandbox.run('install');

      expect(result.exitCode).toBe(0);
      expect(isSymlink(standalone)).toBe(true);
      expect(readlinkSync(standalone)).toBe(sandbox.binaryPath);
      expect(existsSync(sandbox.standalonePath(1))).toBe(false);
    },
  );

  it.skipIf(SKIP_ON_UNIX)('never links standalone installs on Windows', async () => {
    const standalone = sandbox.seedStandalone(0);

    const result = await sandbox.run('install');

    expect(result.exitCode).toBe(0);
    expect(isSymlink(standalone)).toBe(false);
    expect(isStub(standalone, '1.0.0')).toBe(true);
  });

  it.skipIf(SKIP_ON_WINDOWS)(
    'is idempotent: symlinks that already point at the system binary are skipped',
    async () => {
      const standalone = sandbox.seedStandalone(0);
      await sandbox.run('install');

      const result = await sandbox.run('install');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('already symlinked');
      expect(readlinkSync(standalone)).toBe(sandbox.binaryPath);
    },
  );

  it('can be run twice and leaves a single working binary', async () => {
    await sandbox.run('install');

    const result = await sandbox.run('install');

    expect(result.exitCode).toBe(0);
    expect(isRealCli(sandbox.binaryPath)).toBe(true);
    expect(sandbox.extraEntriesNextToBinary().filter((name) => name.endsWith('.new'))).toEqual([]);
  });

  it.skipIf(SKIP_ON_WINDOWS)(
    '--skip-standalone-links installs without touching standalone installs',
    async () => {
      const standalone = sandbox.seedStandalone(0);

      const result = await sandbox.run('install --skip-standalone-links');

      expect(result.exitCode).toBe(0);
      expect(isRealCli(sandbox.binaryPath)).toBe(true);
      expect(isSymlink(standalone)).toBe(false);
      expect(isStub(standalone, '1.0.0')).toBe(true);
    },
  );

  it('--skip-if-present keeps the existing binary', async () => {
    sandbox.seedSystemBinary('1.0.0');

    const result = await sandbox.run('install --skip-if-present');

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain('already present');
    expect(isStub(sandbox.binaryPath, '1.0.0')).toBe(true);
  });

  it.skipIf(SKIP_ON_WINDOWS)('--skip-if-present restores mode 755', async () => {
    sandbox.seedSystemBinary('1.0.0', 0o700);

    await sandbox.run('install --skip-if-present');

    expect(modeOf(sandbox.binaryPath)).toBe(0o755);
  });

  it('--skip-if-present installs when nothing is present yet', async () => {
    const result = await sandbox.run('install --skip-if-present');

    expect(result.exitCode).toBe(0);
    expect(isRealCli(sandbox.binaryPath)).toBe(true);
  });

  it('overwrites an older system binary', async () => {
    sandbox.seedSystemBinary('1.0.0', 0o600);

    const result = await sandbox.run('install');

    expect(result.exitCode).toBe(0);
    expect(isRealCli(sandbox.binaryPath)).toBe(true);
    if (!SKIP_ON_WINDOWS) {
      expect(modeOf(sandbox.binaryPath)).toBe(0o755);
    }
  });

  it.skipIf(SKIP_ON_WINDOWS)('replaces a dangling standalone symlink', async () => {
    const standalone = sandbox.seedStandaloneSymlink(0, `${sandbox.root.path}/missing-target`);

    const result = await sandbox.run('install');

    expect(result.exitCode).toBe(0);
    expect(readlinkSync(standalone)).toBe(sandbox.binaryPath);
  });

  it('is a no-op copy when the installed binary installs itself', async () => {
    await sandbox.run('install');

    const result = await sandbox.run('install', { binaryPath: sandbox.binaryPath });

    expect(result.exitCode).toBe(0);
    expect(isRealCli(sandbox.binaryPath)).toBe(true);
    expect(sandbox.extraEntriesNextToBinary()).toEqual([]);
  });

  it.skipIf(SKIP_ON_WINDOWS || isRoot())(
    'fails with a readable message when the target directory is not writable',
    async () => {
      const lockedParent = sandbox.root.dir('locked').path;
      sandbox.seedFile(`${lockedParent}/placeholder`, '');
      chmodSync(lockedParent, 0o555);

      const result = await harness.run('mdm install', {
        extraEnv: { ...sandbox.env(), SONARQUBE_CLI_MDM_BINARY_PATH: `${lockedParent}/bin/sonar` },
      });

      chmodSync(lockedParent, 0o755);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('EACCES');
    },
  );
});

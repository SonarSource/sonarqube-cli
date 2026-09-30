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

import { chmodSync, existsSync, readFileSync, readlinkSync, statSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { fakeCliScript, isSymlink, MdmSandbox, SKIP_ON_WINDOWS } from './mdm-sandbox';

describe.skipIf(SKIP_ON_WINDOWS)('mdm install', () => {
  let harness: TestHarness;
  let sandbox: MdmSandbox;

  beforeEach(async () => {
    harness = await TestHarness.create();
    sandbox = new MdmSandbox(harness);
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('copies the running binary to the system path as an executable that runs', async () => {
    const reference = await harness.run('--version');

    const result = await sandbox.run('install');

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain(sandbox.binaryPath);
    expect(statSync(sandbox.binaryPath).mode & 0o777).toBe(0o755);
    const installed = await harness.run('--version', { binaryPath: sandbox.binaryPath });
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout).toBe(reference.stdout);
  });

  it('replaces existing standalone installs with symlinks and leaves users without one alone', async () => {
    const standalone = sandbox.seedStandalone(0);

    const result = await sandbox.run('install');

    expect(result.exitCode).toBe(0);
    expect(isSymlink(standalone)).toBe(true);
    expect(readlinkSync(standalone)).toBe(sandbox.binaryPath);
    expect(existsSync(sandbox.standalonePath(1))).toBe(false);
  });

  it('is idempotent: a second run skips symlinks that already point at the system binary', async () => {
    const standalone = sandbox.seedStandalone(0);
    await sandbox.run('install');

    const result = await sandbox.run('install');

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain('already symlinked');
    expect(readlinkSync(standalone)).toBe(sandbox.binaryPath);
  });

  it('--skip-standalone-links installs without touching standalone installs', async () => {
    const standalone = sandbox.seedStandalone(0);

    const result = await sandbox.run('install', '--skip-standalone-links');

    expect(result.exitCode).toBe(0);
    expect(existsSync(sandbox.binaryPath)).toBe(true);
    expect(isSymlink(standalone)).toBe(false);
    expect(readFileSync(standalone, 'utf8')).toContain('standalone');
  });

  it('--skip-if-present keeps the existing binary and restores its permissions', async () => {
    sandbox.seedSystemBinary('1.0.0', 0o700);

    const result = await sandbox.run('install', '--skip-if-present');

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain('already present');
    expect(readFileSync(sandbox.binaryPath, 'utf8')).toContain('1.0.0');
    expect(statSync(sandbox.binaryPath).mode & 0o777).toBe(0o755);
  });

  it('--skip-if-present installs when nothing is present yet', async () => {
    const result = await sandbox.run('install', '--skip-if-present');

    expect(result.exitCode).toBe(0);
    expect(existsSync(sandbox.binaryPath)).toBe(true);
  });

  it('overwrites an older system binary without --skip-if-present', async () => {
    sandbox.seedSystemBinary('1.0.0');
    chmodSync(sandbox.binaryPath, 0o600);

    const result = await sandbox.run('install');

    expect(result.exitCode).toBe(0);
    expect(readFileSync(sandbox.binaryPath).equals(Buffer.from(fakeCliScript('1.0.0')))).toBe(
      false,
    );
    expect(statSync(sandbox.binaryPath).mode & 0o777).toBe(0o755);
  });
});

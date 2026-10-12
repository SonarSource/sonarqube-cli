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

import { existsSync, readlinkSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { TestHarness } from '../../harness';
import {
  eventually,
  isRealCli,
  isStub,
  isSymlink,
  MdmSandbox,
  SKIP_ON_UNIX,
  SKIP_ON_WINDOWS,
  stubBytes,
} from './mdm-sandbox';

setDefaultTimeout(60_000);

describe('mdm lifecycle', () => {
  let harness: TestHarness;
  let sandbox: MdmSandbox;

  beforeEach(async () => {
    harness = await TestHarness.create();
    sandbox = new MdmSandbox(harness);
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('install → update → rollback → remove', async () => {
    const cdn = await harness.newFakeBinariesServer().withStableVersion('2.0.0').start();
    cdn.publishCliArtifact('1.0.0', stubBytes('1.0.0'));
    cdn.publishCliArtifact('2.0.0', stubBytes('2.0.0'));
    const standalone = sandbox.seedStandalone(0);

    expect((await sandbox.run('install')).exitCode).toBe(0);
    expect(isRealCli(sandbox.binaryPath)).toBe(true);
    if (!SKIP_ON_WINDOWS) {
      expect(readlinkSync(standalone)).toBe(sandbox.binaryPath);
    }

    expect((await sandbox.runWithCdn('update', cdn)).exitCode).toBe(0);
    expect(isStub(sandbox.binaryPath, '2.0.0')).toBe(true);
    if (!SKIP_ON_WINDOWS) {
      expect(isStub(standalone, '2.0.0')).toBe(true);
      expect(isSymlink(standalone)).toBe(true);
    }

    expect((await sandbox.runWithCdn('rollback --version 1.0.0', cdn)).exitCode).toBe(0);
    expect(isStub(sandbox.binaryPath, '1.0.0')).toBe(true);
    if (!SKIP_ON_WINDOWS) {
      expect(isStub(standalone, '1.0.0')).toBe(true);
    }

    expect((await sandbox.run('remove')).exitCode).toBe(0);
    await eventually(() => !existsSync(sandbox.binaryPath));
    expect(isSymlink(standalone)).toBe(false);
    expect(existsSync(standalone)).toBe(false);
  });

  it.skipIf(SKIP_ON_UNIX)(
    'leaves the standalone install alone until remove on Windows',
    async () => {
      const standalone = sandbox.seedStandalone(0);

      await sandbox.run('install');

      expect(isStub(standalone, '1.0.0')).toBe(true);
    },
  );

  it('is hidden from the root help but documents its subcommands and flags', async () => {
    const root = await harness.run('--help');
    const mdm = await harness.run('mdm --help');
    const install = await harness.run('mdm install --help');
    const update = await harness.run('mdm update --help');
    const rollback = await harness.run('mdm rollback --help');
    const remove = await harness.run('mdm remove --help');

    expect(root.stdout).not.toMatch(/^\s+mdm\b/m);
    expect(mdm.exitCode).toBe(0);
    for (const subcommand of ['install', 'update', 'rollback', 'remove']) {
      expect(mdm.stdout).toContain(subcommand);
    }
    expect(install.stdout).toContain('--skip-if-present');
    expect(install.stdout).toContain('--skip-standalone-links');
    expect(update.stdout).toContain('--allow-missing-checksum');
    expect(update.stdout).toContain('--artifact-base-url');
    expect(update.stdout).toContain('--force');
    expect(rollback.stdout).toContain('--version');
    expect(remove.stdout).toContain('--mdm-binary-only');
  });
});

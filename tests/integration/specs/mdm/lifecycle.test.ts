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

import { existsSync, readFileSync, readlinkSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { fakeCliScript, isSymlink, MdmSandbox, SKIP_ON_WINDOWS } from './mdm-sandbox';

describe.skipIf(SKIP_ON_WINDOWS)('mdm lifecycle', () => {
  let harness: TestHarness;
  let sandbox: MdmSandbox;

  beforeEach(async () => {
    harness = await TestHarness.create();
    sandbox = new MdmSandbox(harness);
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('install → update → rollback → remove keeps the standalone symlink valid throughout', async () => {
    const cdn = await harness.newFakeBinariesServer().withStableVersion('2.0.0').start();
    cdn.publishCliArtifact('1.0.0', fakeCliScript('1.0.0'));
    cdn.publishCliArtifact('2.0.0', fakeCliScript('2.0.0'));
    const standalone = sandbox.seedStandalone(0);

    expect((await sandbox.run('install')).exitCode).toBe(0);
    expect(readlinkSync(standalone)).toBe(sandbox.binaryPath);

    expect((await sandbox.runWithCdn('update', cdn)).exitCode).toBe(0);
    expect(readFileSync(standalone, 'utf8')).toBe(fakeCliScript('2.0.0'));
    expect(isSymlink(standalone)).toBe(true);

    expect((await sandbox.runWithCdn('rollback --version 1.0.0', cdn)).exitCode).toBe(0);
    expect(readFileSync(standalone, 'utf8')).toBe(fakeCliScript('1.0.0'));

    expect((await sandbox.run('remove')).exitCode).toBe(0);
    expect(existsSync(sandbox.binaryPath)).toBe(false);
    expect(isSymlink(standalone)).toBe(false);
    expect(existsSync(standalone)).toBe(false);
  });

  it('an installed binary can update itself from the CDN', async () => {
    const cdn = await harness.newFakeBinariesServer().withStableVersion('2.0.0').start();
    cdn.publishCliArtifact('2.0.0', fakeCliScript('2.0.0'));
    expect((await sandbox.run('install')).exitCode).toBe(0);

    const result = await harness.run(`mdm update --artifact-base-url ${cdn.cliArtifactBaseUrl()}`, {
      binaryPath: sandbox.binaryPath,
      extraEnv: sandbox.env(),
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(sandbox.binaryPath, 'utf8')).toBe(fakeCliScript('2.0.0'));
  });
});

describe('mdm command surface', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('is hidden from the root help but documents its subcommands and Permissive flags', async () => {
    const root = await harness.run('--help');
    const mdm = await harness.run('mdm --help');

    expect(root.stdout).not.toMatch(/^\s+mdm\b/m);
    expect(mdm.exitCode).toBe(0);
    for (const subcommand of ['install', 'update', 'rollback', 'remove']) {
      expect(mdm.stdout).toContain(subcommand);
    }
    const install = await harness.run('mdm install --help');
    expect(install.stdout).toContain('--skip-if-present');
    expect(install.stdout).toContain('--skip-standalone-links');
    const update = await harness.run('mdm update --help');
    expect(update.stdout).toContain('--allow-missing-checksum');
    expect(update.stdout).toContain('--artifact-base-url');
  });
});

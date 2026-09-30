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

import { chmodSync, existsSync, lstatSync, readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { fakeCliScript, isSymlink, MdmSandbox, SKIP_ON_WINDOWS } from './mdm-sandbox';

describe.skipIf(SKIP_ON_WINDOWS)('mdm remove', () => {
  let harness: TestHarness;
  let sandbox: MdmSandbox;

  beforeEach(async () => {
    harness = await TestHarness.create();
    sandbox = new MdmSandbox(harness);
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('deletes the system binary, other copies on PATH and every standalone install', async () => {
    sandbox.seedSystemBinary('1.0.0');
    const pathCopy = sandbox.seedPathCopy('0.9.0');
    const regular = sandbox.seedStandalone(0);
    const linked = sandbox.seedStandaloneSymlink(1);

    const result = await sandbox.run('remove');

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain('SonarQube CLI removed');
    expect(existsSync(sandbox.binaryPath)).toBe(false);
    expect(existsSync(pathCopy)).toBe(false);
    expect(existsSync(regular)).toBe(false);
    expect(lstatSync(linked, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('removes a chain of copies that resolve one after another on PATH', async () => {
    sandbox.seedSystemBinary('1.0.0');
    sandbox.seedPathCopy('0.9.0');
    const secondDir = sandbox.root.dir('second-path-bin');
    secondDir.writeFile('sonar', fakeCliScript('0.8.0'));
    const second = secondDir.file('sonar');
    chmodSync(second.path, 0o755);

    const result = await harness.run('mdm remove', {
      extraEnv: { ...sandbox.env(), PATH: `${sandbox.pathDir}:${secondDir.path}:/usr/bin:/bin` },
    });

    expect(result.exitCode).toBe(0);
    expect(second.exists()).toBe(false);
    expect(existsSync(`${sandbox.pathDir}/sonar`)).toBe(false);
  });

  it('refuses to delete a PATH entry that does not look like the CLI', async () => {
    const impostor = sandbox.seedPathCopy('n/a', '#!/bin/sh\necho "not a version"\n');

    const result = await sandbox.run('remove');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('does not look like the SonarQube CLI');
    expect(readFileSync(impostor, 'utf8')).toContain('not a version');
  });

  it('succeeds when there is nothing to remove', async () => {
    const result = await sandbox.run('remove');

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain('SonarQube CLI removed');
  });

  it('--mdm-binary-only keeps other copies on PATH and standalone installs', async () => {
    sandbox.seedSystemBinary('1.0.0');
    const pathCopy = sandbox.seedPathCopy('0.9.0');
    const standalone = sandbox.seedStandalone(0);

    const result = await sandbox.run('remove', '--mdm-binary-only');

    expect(result.exitCode).toBe(0);
    expect(existsSync(sandbox.binaryPath)).toBe(false);
    expect(existsSync(pathCopy)).toBe(true);
    expect(isSymlink(standalone)).toBe(false);
    expect(existsSync(standalone)).toBe(true);
  });
});

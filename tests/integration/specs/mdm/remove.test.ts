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

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { delimiter } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { IS_WINDOWS, TestHarness } from '../../harness';
import { isStub, isSymlink, MdmSandbox, SKIP_ON_WINDOWS, stubPath } from './mdm-sandbox';

setDefaultTimeout(60_000);

describe('mdm remove', () => {
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
    const pathCopy = sandbox.seedPathCopy(stubPath('1.0.0'));
    const regular = sandbox.seedStandalone(0);
    const second = sandbox.seedStandalone(1);

    const result = await sandbox.run('remove');

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain('SonarQube CLI removed');
    expect(existsSync(sandbox.binaryPath)).toBe(false);
    expect(existsSync(pathCopy)).toBe(false);
    expect(existsSync(regular)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it.skipIf(SKIP_ON_WINDOWS)('removes standalone symlinks and dangling symlinks', async () => {
    sandbox.seedSystemBinary('1.0.0');
    const linked = sandbox.seedStandaloneSymlink(0);
    const dangling = sandbox.seedStandaloneSymlink(1, `${sandbox.root.path}/missing-target`);

    const result = await sandbox.run('remove');

    expect(result.exitCode).toBe(0);
    expect(lstatSync(linked, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(dangling, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('removes a chain of copies that resolve one after another on PATH', async () => {
    sandbox.seedSystemBinary('1.0.0');
    const first = sandbox.seedPathCopy(stubPath('1.0.0'));
    const secondDir = sandbox.root.dir('second-path-bin').path;
    const second = sandbox.seedPathCopy(stubPath('1.0.0'), secondDir);
    const extraPath = `${sandbox.pathDir}${delimiter}${secondDir}${delimiter}${sandbox.env().PATH}`;

    const result = await sandbox.run('remove', { extraEnv: { PATH: extraPath } });

    expect(result.exitCode).toBe(0);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it('refuses to delete a PATH entry that does not look like the CLI', async () => {
    const impostor = sandbox.seedPathCopy(stubPath('impostor'));

    const result = await sandbox.run('remove');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('does not look like the SonarQube CLI');
    expect(existsSync(impostor)).toBe(true);
  });

  it('succeeds when there is nothing to remove', async () => {
    const result = await sandbox.run('remove');

    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain('SonarQube CLI removed');
  });

  it('--mdm-binary-only keeps other copies on PATH and standalone installs', async () => {
    sandbox.seedSystemBinary('1.0.0');
    const pathCopy = sandbox.seedPathCopy(stubPath('1.0.0'));
    const standalone = sandbox.seedStandalone(0);

    const result = await sandbox.run('remove --mdm-binary-only');

    expect(result.exitCode).toBe(0);
    expect(existsSync(sandbox.binaryPath)).toBe(false);
    expect(existsSync(pathCopy)).toBe(true);
    expect(isSymlink(standalone)).toBe(false);
    expect(isStub(standalone, '1.0.0')).toBe(true);
  });

  it('lets the installed CLI delete itself while it is running', async () => {
    await sandbox.run('install');

    const result = await sandbox.run('remove', { binaryPath: sandbox.binaryPath });

    expect(result.exitCode).toBe(0);
    expect(existsSync(sandbox.binaryPath)).toBe(false);
    expect(sandbox.unscheduledEntriesNextToBinary()).toEqual([]);
    expect(sandbox.extraEntriesNextToBinary()).toHaveLength(IS_WINDOWS ? 1 : 0);
  });

  it('keeps unrelated files in the user homes', async () => {
    sandbox.seedSystemBinary('1.0.0');
    sandbox.seedStandalone(0);
    const unrelated = `${sandbox.homes[0]}/notes.txt`;
    sandbox.seedFile(unrelated, 'keep me');

    await sandbox.run('remove');

    expect(readFileSync(unrelated, 'utf8')).toBe('keep me');
  });
});

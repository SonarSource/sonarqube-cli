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

// Real-system e2e for `sonar mdm`: real install location, real user enumeration, real file locks.
// Skipped unless elevated on CI (see _helpers.ts).

import { existsSync, lstatSync, mkdirSync, readlinkSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from 'bun:test';

import { standaloneBinaryPath } from '@/commands/mdm/mdm-environment.ts';

import { getCliBinaryPath } from '../../integration/harness/cli-runner.js';
import type { FakeBinariesServer } from '../../integration/harness/fake-binaries-server.js';
import { FakeBinariesServerBuilder } from '../../integration/harness/fake-binaries-server.js';
import {
  eventually,
  isRealCli,
  isStub,
  stubBytes,
  stubPath,
} from '../../integration/specs/mdm/mdm-sandbox';
import {
  CAN_RUN_SYSTEM_E2E,
  directoryEntries,
  forceRemove,
  IS_WINDOWS,
  isolatedEnv,
  machinePath,
  makeIsolatedHome,
  REAL_CDN_BASE_URL,
  realUserHomeIfEnumerable,
  removeSystemInstall,
  restoreMachinePath,
  runMdm,
  runUnelevated,
  SYSTEM_BINARY,
} from './_helpers';

setDefaultTimeout(180_000);

const STANDALONE_ENUMERABLE_HOME = realUserHomeIfEnumerable();
const SEMVER_PREFIX = /^\d+\.\d+\.\d+/;

describe.skipIf(!CAN_RUN_SYSTEM_E2E)('sonar mdm on the real system', () => {
  let home: string;
  let env: Record<string, string>;
  let originalMachinePath = '';
  let cdn: FakeBinariesServer | undefined;
  const seededStandalones: string[] = [];

  beforeAll(() => {
    if (IS_WINDOWS) {
      originalMachinePath = machinePath();
    }
  });

  afterAll(() => {
    if (IS_WINDOWS) {
      restoreMachinePath(originalMachinePath);
    }
  });

  beforeEach(() => {
    home = makeIsolatedHome();
    env = isolatedEnv(home);
  });

  afterEach(async () => {
    removeSystemInstall();
    for (const path of seededStandalones.splice(0)) {
      forceRemove(path);
    }
    forceRemove(home);
    await cdn?.stop();
    cdn = undefined;
  });

  async function startCdn(stableVersion = '2.0.0'): Promise<FakeBinariesServer> {
    cdn = await new FakeBinariesServerBuilder().withStableVersion(stableVersion).start();
    return cdn;
  }

  function staleEntries(): string[] {
    return directoryEntries(dirname(SYSTEM_BINARY)).filter((name) =>
      name.startsWith(`${basename(SYSTEM_BINARY)}.`),
    );
  }

  function seedRealStandalone(): string {
    const path = standaloneBinaryPath(STANDALONE_ENUMERABLE_HOME as string);
    mkdirSync(dirname(path), { recursive: true });
    Bun.spawnSync(['cp', stubPath('1.0.0'), path]);
    seededStandalones.push(path);
    return path;
  }

  describe('install', () => {
    it('installs to the system location and a regular user can run it', async () => {
      const result = await runMdm(['install'], env);

      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(isRealCli(SYSTEM_BINARY)).toBe(true);
      const reference = await runUnelevated(getCliBinaryPath(), ['--version'], home);
      const installed = await runUnelevated(SYSTEM_BINARY, ['--version'], home);
      expect(installed.exitCode).toBe(0);
      expect(installed.stdout).toBe(reference.stdout);
    });

    it.skipIf(IS_WINDOWS || STANDALONE_ENUMERABLE_HOME === null)(
      'finds the runner user through the OS user database and links its standalone install',
      async () => {
        const standalone = seedRealStandalone();

        const result = await runMdm(['install'], env);

        expect(result.exitCode, result.stdout + result.stderr).toBe(0);
        expect(lstatSync(standalone).isSymbolicLink()).toBe(true);
        expect(readlinkSync(standalone)).toBe(SYSTEM_BINARY);
      },
    );

    it.skipIf(!IS_WINDOWS)('grants Authenticated Users read and execute', async () => {
      await runMdm(['install'], env);

      const acl = Bun.spawnSync(['icacls', SYSTEM_BINARY]).stdout.toString();

      expect(acl).toContain('Authenticated Users:(RX)');
    });

    it.skipIf(!IS_WINDOWS)(
      'adds the install directory to the machine PATH once, even when run twice',
      async () => {
        await runMdm(['install'], env);
        await runMdm(['install'], env);

        const entries = machinePath()
          .split(';')
          .filter((entry) => entry.toLowerCase() === dirname(SYSTEM_BINARY).toLowerCase());
        expect(entries).toHaveLength(1);
      },
    );

    it.skipIf(process.platform !== 'darwin')('clears the quarantine attribute', async () => {
      await runMdm(['install'], env);

      const attribute = Bun.spawnSync(['xattr', '-p', 'com.apple.quarantine', SYSTEM_BINARY]);

      expect(attribute.exitCode).not.toBe(0);
    });
  });

  describe('update, rollback and remove run by the installed CLI itself', () => {
    it('replaces the running system binary and leaves no stale files', async () => {
      await runMdm(['install'], env);
      const server = await startCdn('7.7.7');
      server.publishCliArtifact('7.7.7', stubBytes('2.0.0'));

      const result = await runMdm(
        ['update', '--artifact-base-url', server.cliArtifactBaseUrl()],
        env,
        SYSTEM_BINARY,
      );

      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(isStub(SYSTEM_BINARY, '2.0.0')).toBe(true);
      await eventually(() => staleEntries().length === 0);
    });

    it('rolls the running system binary back to an older version', async () => {
      await runMdm(['install'], env);
      const server = await startCdn();
      server.publishCliArtifact('1.0.0', stubBytes('1.0.0'));

      const result = await runMdm(
        ['rollback', '--version', '1.0.0', '--artifact-base-url', server.cliArtifactBaseUrl()],
        env,
        SYSTEM_BINARY,
      );

      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(isStub(SYSTEM_BINARY, '1.0.0')).toBe(true);
    });

    it('deletes itself, other copies on PATH and standalone installs', async () => {
      await runMdm(['install'], env);

      const result = await runMdm(['remove'], env, SYSTEM_BINARY);

      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      await eventually(() => !existsSync(SYSTEM_BINARY));
      await eventually(() => staleEntries().length === 0);
    });

    it.skipIf(IS_WINDOWS || STANDALONE_ENUMERABLE_HOME === null)(
      'removes the real user standalone install found through the OS user database',
      async () => {
        await runMdm(['install'], env);
        const standalone = seedRealStandalone();

        const result = await runMdm(['remove'], env);

        expect(result.exitCode, result.stdout + result.stderr).toBe(0);
        expect(lstatSync(standalone, { throwIfNoEntry: false })).toBeUndefined();
      },
    );

    it.skipIf(!IS_WINDOWS)('removes the install directory from the machine PATH', async () => {
      await runMdm(['install'], env);
      await runMdm(['remove'], env, SYSTEM_BINARY);

      const entries = machinePath()
        .split(';')
        .map((entry) => entry.toLowerCase());
      expect(entries).not.toContain(dirname(SYSTEM_BINARY).toLowerCase());
    });
  });

  describe('against the real CDN', () => {
    it('updates to the published stable release and rolls back to it', async () => {
      const stable = (await (await fetch(`${REAL_CDN_BASE_URL}/stable.version`)).text()).trim();

      const update = await runMdm(['update'], env);

      expect(update.exitCode, update.stdout + update.stderr).toBe(0);
      const afterUpdate = await runUnelevated(SYSTEM_BINARY, ['--version'], home);
      expect(afterUpdate.exitCode).toBe(0);
      expect(afterUpdate.stdout.trim()).toMatch(SEMVER_PREFIX);

      const rollback = await runMdm(['rollback', '--version', stable], env);

      expect(rollback.exitCode, rollback.stdout + rollback.stderr).toBe(0);
      const afterRollback = await runUnelevated(SYSTEM_BINARY, ['--version'], home);
      expect(afterRollback.stdout.trim()).toBe(afterUpdate.stdout.trim());
    });
  });
});

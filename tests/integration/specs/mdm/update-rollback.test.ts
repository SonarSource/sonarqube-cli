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

import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { TestHarness } from '../../harness';
import type { FakeBinariesServer } from '../../harness/fake-binaries-server.js';
import {
  eventually,
  isRealCli,
  isStub,
  MdmSandbox,
  MISMATCHED_CHECKSUM,
  modeOf,
  NOT_AN_EXECUTABLE,
  SKIP_ON_WINDOWS,
  stubBytes,
} from './mdm-sandbox';

setDefaultTimeout(60_000);

describe('mdm update and rollback', () => {
  let harness: TestHarness;
  let sandbox: MdmSandbox;
  let cdn: FakeBinariesServer;

  beforeEach(async () => {
    harness = await TestHarness.create();
    sandbox = new MdmSandbox(harness);
    cdn = await harness.newFakeBinariesServer().withStableVersion('2.0.0').start();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function publish(version: string, stubVersion = version): void {
    cdn.publishCliArtifact(version, stubBytes(stubVersion));
  }

  function artifactRequests(): string[] {
    return cdn
      .getRecordedRequests()
      .map((request) => request.path)
      .filter((path) => /\.(bin|exe)$/.test(path));
  }

  function output(result: { stdout: string; stderr: string }): string {
    return result.stdout + result.stderr;
  }

  describe('update', () => {
    it('installs the stable version when nothing is installed', async () => {
      publish('2.0.0');

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(0);
      expect(output(result)).toContain('Target version: 2.0.0');
      expect(isStub(sandbox.binaryPath, '2.0.0')).toBe(true);
    });

    it.skipIf(SKIP_ON_WINDOWS)('installs with mode 755', async () => {
      publish('2.0.0');

      await sandbox.runWithCdn('update', cdn);

      expect(modeOf(sandbox.binaryPath)).toBe(0o755);
    });

    it('replaces an older binary and leaves no staging files behind', async () => {
      sandbox.seedSystemBinary('1.0.0');
      publish('2.0.0');

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(0);
      expect(isStub(sandbox.binaryPath, '2.0.0')).toBe(true);
      expect(sandbox.extraEntriesNextToBinary()).toEqual([]);
    });

    it('does not download anything when already at the target version', async () => {
      sandbox.seedSystemBinary('2.0.0');
      publish('2.0.0');

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(0);
      expect(output(result)).toContain('Already at version 2.0.0');
      expect(artifactRequests()).toEqual([]);
    });

    it('treats a build-number suffix on the target as the same version', async () => {
      sandbox.seedSystemBinary('2.0.0');
      cdn.setStableVersion('2.0.0.1234');

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(0);
      expect(output(result)).toContain('Already at version 2.0.0.1234');
      expect(artifactRequests()).toEqual([]);
    });

    it.skipIf(SKIP_ON_WINDOWS)('restores mode 755 on an up-to-date binary', async () => {
      sandbox.seedSystemBinary('2.0.0', 0o700);

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(0);
      expect(modeOf(sandbox.binaryPath)).toBe(0o755);
    });

    it('--force re-downloads even when already at the target version', async () => {
      sandbox.seedSystemBinary('2.0.0');
      publish('2.0.0');

      const result = await sandbox.runWithCdn('update --force', cdn);

      expect(result.exitCode).toBe(0);
      expect(artifactRequests()).toHaveLength(1);
    });

    it('--approved-version pins the version instead of reading stable.version', async () => {
      publish('3.0.0');

      const result = await sandbox.runWithCdn('update --approved-version 3.0.0', cdn);

      expect(result.exitCode).toBe(0);
      expect(isStub(sandbox.binaryPath, '3.0.0')).toBe(true);
      expect(cdn.getRecordedRequests().some((r) => r.path.endsWith('stable.version'))).toBe(false);
    });

    it.skipIf(SKIP_ON_WINDOWS)(
      'falls back to the .exe artifact published before the .bin convention',
      async () => {
        cdn.publishCliArtifact('2.0.0', stubBytes('2.0.0'), { suffix: '.exe' });

        const result = await sandbox.runWithCdn('update', cdn);

        expect(result.exitCode).toBe(0);
        expect(isStub(sandbox.binaryPath, '2.0.0')).toBe(true);
        expect(artifactRequests().map((path) => path.split('.').at(-1))).toEqual(['bin', 'exe']);
      },
    );

    it('aborts on a checksum mismatch and keeps the installed binary', async () => {
      sandbox.seedSystemBinary('1.0.0');
      cdn.publishCliArtifact('2.0.0', stubBytes('2.0.0'), { checksum: MISMATCHED_CHECKSUM });

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('SHA256 mismatch');
      expect(isStub(sandbox.binaryPath, '1.0.0')).toBe(true);
    });

    it('aborts when the checksum file is missing', async () => {
      sandbox.seedSystemBinary('1.0.0');
      cdn.publishCliArtifact('2.0.0', stubBytes('2.0.0'), { checksum: null });

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(1);
      expect(isStub(sandbox.binaryPath, '1.0.0')).toBe(true);
    });

    it('--allow-missing-checksum proceeds with a warning when the checksum file is missing', async () => {
      cdn.publishCliArtifact('2.0.0', stubBytes('2.0.0'), { checksum: null });

      const result = await sandbox.runWithCdn('update --allow-missing-checksum', cdn);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Skipping the integrity check');
      expect(isStub(sandbox.binaryPath, '2.0.0')).toBe(true);
    });

    it('--allow-missing-checksum still aborts on a mismatch', async () => {
      cdn.publishCliArtifact('2.0.0', stubBytes('2.0.0'), { checksum: MISMATCHED_CHECKSUM });

      const result = await sandbox.runWithCdn('update --allow-missing-checksum', cdn);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('SHA256 mismatch');
      expect(sandbox.extraEntriesNextToBinary()).toEqual([]);
    });

    it('accepts an upper-case digest followed by a file name in the checksum file', async () => {
      const digest = createHash('sha256').update(stubBytes('2.0.0')).digest('hex').toUpperCase();
      cdn.publishCliArtifact('2.0.0', stubBytes('2.0.0'), { checksum: digest });

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(0);
      expect(isStub(sandbox.binaryPath, '2.0.0')).toBe(true);
    });

    it('aborts before the swap when the download is not an executable', async () => {
      sandbox.seedSystemBinary('1.0.0');
      cdn.publishCliArtifact('2.0.0', NOT_AN_EXECUTABLE);

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Installation verification failed');
      expect(isStub(sandbox.binaryPath, '1.0.0')).toBe(true);
      expect(sandbox.extraEntriesNextToBinary()).toEqual([]);
    });

    it('keeps the installed binary when the approved version is not published', async () => {
      sandbox.seedSystemBinary('1.0.0');

      const result = await sandbox.runWithCdn('update --approved-version 9.9.9', cdn);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Could not download');
      expect(isStub(sandbox.binaryPath, '1.0.0')).toBe(true);
    });

    it('fails when stable.version is not a version', async () => {
      sandbox.seedSystemBinary('1.0.0');
      cdn.setStableVersion('<html>nope</html>');

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(1);
      expect(artifactRequests()).toEqual([]);
      expect(isStub(sandbox.binaryPath, '1.0.0')).toBe(true);
    });

    it('fails when stable.version is missing from the CDN', async () => {
      sandbox.seedSystemBinary('1.0.0');
      const emptyCdn = await harness.newFakeBinariesServer().start();

      const result = await sandbox.runWithCdn('update', emptyCdn);

      expect(result.exitCode).toBe(1);
      expect(isStub(sandbox.binaryPath, '1.0.0')).toBe(true);
    });

    it('fails without touching the binary when the CDN is unreachable', async () => {
      sandbox.seedSystemBinary('1.0.0');
      const deadCdn = await harness.newFakeBinariesServer().start();
      const deadUrl = deadCdn.cliArtifactBaseUrl();
      await deadCdn.stop();

      const result = await sandbox.run(`update --artifact-base-url ${deadUrl}`);

      expect(result.exitCode).toBe(1);
      expect(isStub(sandbox.binaryPath, '1.0.0')).toBe(true);
    });

    it('removes its temporary download on success and on failure', async () => {
      publish('2.0.0');
      cdn.publishCliArtifact('3.0.0', stubBytes('3.0.0'), { checksum: MISMATCHED_CHECKSUM });

      await sandbox.runWithCdn('update', cdn);
      const afterSuccess = sandbox.leftoverDownloads();
      await sandbox.runWithCdn('update --approved-version 3.0.0', cdn);

      expect(afterSuccess).toEqual([]);
      expect(sandbox.leftoverDownloads()).toEqual([]);
    });

    it('lets the installed CLI replace itself while it is running', async () => {
      await sandbox.run('install');
      cdn.publishCliArtifact('7.7.7', stubBytes('2.0.0'));
      cdn.setStableVersion('7.7.7');

      const result = await sandbox.runWithCdn('update', cdn, { binaryPath: sandbox.binaryPath });

      expect(result.exitCode).toBe(0);
      expect(isStub(sandbox.binaryPath, '2.0.0')).toBe(true);
      expect(isRealCli(sandbox.binaryPath)).toBe(false);
      await eventually(() => sandbox.extraEntriesNextToBinary().length === 0);
    });
  });

  describe('rollback', () => {
    it('replaces a newer binary with the requested older version', async () => {
      sandbox.seedSystemBinary('3.0.0');
      publish('1.0.0');

      const result = await sandbox.runWithCdn('rollback --version 1.0.0', cdn);

      expect(result.exitCode).toBe(0);
      expect(output(result)).toContain('rolled back to 1.0.0');
      expect(isStub(sandbox.binaryPath, '1.0.0')).toBe(true);
    });

    it('installs when no binary exists yet', async () => {
      publish('1.0.0');

      const result = await sandbox.runWithCdn('rollback --version 1.0.0', cdn);

      expect(result.exitCode).toBe(0);
      expect(isStub(sandbox.binaryPath, '1.0.0')).toBe(true);
    });

    it('re-downloads even when already at that version', async () => {
      sandbox.seedSystemBinary('1.0.0');
      publish('1.0.0');

      const result = await sandbox.runWithCdn('rollback --version 1.0.0', cdn);

      expect(result.exitCode).toBe(0);
      expect(artifactRequests()).toHaveLength(1);
    });

    it('requires --version', async () => {
      const result = await sandbox.runWithCdn('rollback', cdn);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--version');
      expect(artifactRequests()).toEqual([]);
    });

    it('fails when the version is not published', async () => {
      sandbox.seedSystemBinary('3.0.0');

      const result = await sandbox.runWithCdn('rollback --version 9.9.9', cdn);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Could not download');
      expect(isStub(sandbox.binaryPath, '3.0.0')).toBe(true);
    });

    it('aborts on a checksum mismatch and keeps the installed binary', async () => {
      sandbox.seedSystemBinary('3.0.0');
      cdn.publishCliArtifact('1.0.0', stubBytes('1.0.0'), { checksum: MISMATCHED_CHECKSUM });

      const result = await sandbox.runWithCdn('rollback --version 1.0.0', cdn);

      expect(result.exitCode).toBe(1);
      expect(isStub(sandbox.binaryPath, '3.0.0')).toBe(true);
    });
  });

  describe('option validation', () => {
    it.each(['1.2.3$(id)', '1.2.3;rm', 'latest'])('rejects the version %p', async (version) => {
      const result = await sandbox.run(`update --approved-version '${version}'`);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Expected a version');
    });

    it('rejects a malformed rollback version', async () => {
      const result = await sandbox.runWithCdn('rollback --version latest', cdn);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Expected a version');
      expect(artifactRequests()).toEqual([]);
    });

    it('rejects a plain-http, non-loopback artifact base URL', async () => {
      const result = await sandbox.run(
        'update --approved-version 1.0.0 --artifact-base-url http://mirror.example.com',
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('https://');
    });

    it('rejects an artifact base URL that is not a URL', async () => {
      const result = await sandbox.run('update --artifact-base-url nonsense');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Not a valid URL');
    });
  });
});

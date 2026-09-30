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

import { existsSync, readFileSync, statSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import type { FakeBinariesServer } from '../../harness/fake-binaries-server.js';
import { fakeCliScript, MdmSandbox, SKIP_ON_WINDOWS } from './mdm-sandbox';

const MISMATCHED_CHECKSUM = 'f'.repeat(64);

describe.skipIf(SKIP_ON_WINDOWS)('mdm update and rollback', () => {
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

  function artifactRequests(): string[] {
    return cdn
      .getRecordedRequests()
      .map((request) => request.path)
      .filter((path) => path.endsWith('.bin') || path.endsWith('.exe'));
  }

  describe('update', () => {
    it('installs the stable version when nothing is installed', async () => {
      cdn.publishCliArtifact('2.0.0', fakeCliScript('2.0.0'));

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Target version: 2.0.0');
      expect(readFileSync(sandbox.binaryPath, 'utf8')).toBe(fakeCliScript('2.0.0'));
      expect(statSync(sandbox.binaryPath).mode & 0o777).toBe(0o755);
    });

    it('replaces an older binary and leaves no staging files behind', async () => {
      sandbox.seedSystemBinary('1.0.0');
      cdn.publishCliArtifact('2.0.0', fakeCliScript('2.0.0'));

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(0);
      expect(readFileSync(sandbox.binaryPath, 'utf8')).toBe(fakeCliScript('2.0.0'));
      expect(existsSync(`${sandbox.binaryPath}.new`)).toBe(false);
    });

    it('does not download anything when already at the target version', async () => {
      sandbox.seedSystemBinary('2.0.0');
      cdn.publishCliArtifact('2.0.0', fakeCliScript('2.0.0'));

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Already at version 2.0.0');
      expect(artifactRequests()).toEqual([]);
    });

    it('restores mode 755 on an up-to-date binary', async () => {
      sandbox.seedSystemBinary('2.0.0', 0o700);

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(0);
      expect(statSync(sandbox.binaryPath).mode & 0o777).toBe(0o755);
    });

    it('--force re-downloads even when already at the target version', async () => {
      sandbox.seedSystemBinary('2.0.0');
      cdn.publishCliArtifact('2.0.0', fakeCliScript('2.0.0'));

      const result = await sandbox.runWithCdn('update --force', cdn);

      expect(result.exitCode).toBe(0);
      expect(artifactRequests()).toHaveLength(1);
    });

    it('--approved-version pins the version instead of reading stable.version', async () => {
      cdn.publishCliArtifact('3.1.0', fakeCliScript('3.1.0'));

      const result = await sandbox.runWithCdn('update --approved-version 3.1.0', cdn);

      expect(result.exitCode).toBe(0);
      expect(readFileSync(sandbox.binaryPath, 'utf8')).toBe(fakeCliScript('3.1.0'));
      expect(cdn.getRecordedRequests().some((r) => r.path.endsWith('stable.version'))).toBe(false);
    });

    it('falls back to the .exe artifact published before the .bin convention', async () => {
      cdn.publishCliArtifact('2.0.0', fakeCliScript('2.0.0'), { suffix: '.exe' });

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(0);
      expect(readFileSync(sandbox.binaryPath, 'utf8')).toBe(fakeCliScript('2.0.0'));
      expect(artifactRequests().map((path) => path.split('.').at(-1))).toEqual(['bin', 'exe']);
    });

    it('aborts on a checksum mismatch and keeps the installed binary', async () => {
      sandbox.seedSystemBinary('1.0.0');
      cdn.publishCliArtifact('2.0.0', fakeCliScript('2.0.0'), { checksum: MISMATCHED_CHECKSUM });

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('SHA256 mismatch');
      expect(readFileSync(sandbox.binaryPath, 'utf8')).toBe(fakeCliScript('1.0.0'));
    });

    it('aborts when the checksum file is missing', async () => {
      sandbox.seedSystemBinary('1.0.0');
      cdn.publishCliArtifact('2.0.0', fakeCliScript('2.0.0'), { checksum: null });

      const result = await sandbox.runWithCdn('update', cdn);

      expect(result.exitCode).toBe(1);
      expect(readFileSync(sandbox.binaryPath, 'utf8')).toBe(fakeCliScript('1.0.0'));
    });

    it('--allow-missing-checksum proceeds with a warning when the checksum file is missing', async () => {
      cdn.publishCliArtifact('2.0.0', fakeCliScript('2.0.0'), { checksum: null });

      const result = await sandbox.runWithCdn('update --allow-missing-checksum', cdn);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Skipping the integrity check');
      expect(readFileSync(sandbox.binaryPath, 'utf8')).toBe(fakeCliScript('2.0.0'));
    });

    it('--allow-missing-checksum still aborts on a mismatch', async () => {
      cdn.publishCliArtifact('2.0.0', fakeCliScript('2.0.0'), { checksum: MISMATCHED_CHECKSUM });

      const result = await sandbox.runWithCdn('update --allow-missing-checksum', cdn);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('SHA256 mismatch');
      expect(existsSync(sandbox.binaryPath)).toBe(false);
    });

    it('keeps the installed binary when the approved version is not published', async () => {
      sandbox.seedSystemBinary('1.0.0');

      const result = await sandbox.runWithCdn('update --approved-version 9.9.9', cdn);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Could not download');
      expect(readFileSync(sandbox.binaryPath, 'utf8')).toBe(fakeCliScript('1.0.0'));
    });
  });

  describe('rollback', () => {
    it('replaces a newer binary with the requested older version', async () => {
      sandbox.seedSystemBinary('3.0.0');
      cdn.publishCliArtifact('1.0.0', fakeCliScript('1.0.0'));

      const result = await sandbox.runWithCdn('rollback --version 1.0.0', cdn);

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('rolled back to 1.0.0');
      expect(readFileSync(sandbox.binaryPath, 'utf8')).toBe(fakeCliScript('1.0.0'));
    });

    it('re-downloads even when already at that version', async () => {
      sandbox.seedSystemBinary('1.0.0');
      cdn.publishCliArtifact('1.0.0', fakeCliScript('1.0.0'));

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
      expect(readFileSync(sandbox.binaryPath, 'utf8')).toBe(fakeCliScript('3.0.0'));
    });

    it('aborts on a checksum mismatch and keeps the installed binary', async () => {
      sandbox.seedSystemBinary('3.0.0');
      cdn.publishCliArtifact('1.0.0', fakeCliScript('1.0.0'), { checksum: MISMATCHED_CHECKSUM });

      const result = await sandbox.runWithCdn('rollback --version 1.0.0', cdn);

      expect(result.exitCode).toBe(1);
      expect(readFileSync(sandbox.binaryPath, 'utf8')).toBe(fakeCliScript('3.0.0'));
    });
  });

  describe('option validation', () => {
    it.each(['1.2.3$(id)', '1.2.3;rm', 'latest'])('rejects the version %p', async (version) => {
      const result = await sandbox.run(`update --approved-version '${version}'`);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Expected a version');
      expect(existsSync(sandbox.binaryPath)).toBe(false);
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

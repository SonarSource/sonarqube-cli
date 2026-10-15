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

import { existsSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

import { TestHarness } from '../../harness';
import type { FakeBinariesServer } from '../../harness/fake-binaries-server.js';
import {
  cliBytes,
  isRealCli,
  MdmSandbox,
  MISMATCHED_CHECKSUM,
  SKIP_ON_WINDOWS,
} from './mdm-sandbox';

const RUNNER_VERSION = '9.9.9';

setDefaultTimeout(60_000);

describe('mdm install bootstrap script', () => {
  let harness: TestHarness;
  let sandbox: MdmSandbox;
  let cdn: FakeBinariesServer;
  let runnerBytes: Buffer;

  beforeEach(async () => {
    harness = await TestHarness.create();
    sandbox = new MdmSandbox(harness);
    cdn = await harness.newFakeBinariesServer().withStableVersion(RUNNER_VERSION).start();
    runnerBytes = cliBytes();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function requestedPaths(): string[] {
    return cdn.getRecordedRequests().map((request) => request.path);
  }

  function downloads(): string[] {
    return requestedPaths().filter((path) => /\.(bin|exe)$/.test(path));
  }

  it('resolves stable.version, downloads and verifies once, and installs through mdm install', async () => {
    cdn.publishCliArtifact(RUNNER_VERSION, runnerBytes);

    const result = await sandbox.runBootstrap({ baseUrl: cdn.cliArtifactBaseUrl() });

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`Target version: ${RUNNER_VERSION}`);
    expect(result.stdout).toContain('SHA256 verified');
    expect(isRealCli(sandbox.binaryPath)).toBe(true);
    expect(downloads()).toHaveLength(1);
    expect(requestedPaths().filter((path) => path.endsWith('stable.version'))).toHaveLength(1);
  });

  it('pins the version with the approved-version variable and skips stable.version', async () => {
    cdn.publishCliArtifact('8.8.8', runnerBytes);

    const result = await sandbox.runBootstrap({
      baseUrl: cdn.cliArtifactBaseUrl(),
      approvedVersion: '8.8.8',
    });

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Target version: 8.8.8');
    expect(requestedPaths().some((path) => path.endsWith('stable.version'))).toBe(false);
    expect(isRealCli(sandbox.binaryPath)).toBe(true);
  });

  it('falls back to stable.version when the approved-version variable is empty', async () => {
    cdn.publishCliArtifact(RUNNER_VERSION, runnerBytes);

    const result = await sandbox.runBootstrap({
      baseUrl: cdn.cliArtifactBaseUrl(),
      approvedVersion: '',
    });

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`Target version: ${RUNNER_VERSION}`);
  });

  it('rejects a malformed approved version before any download', async () => {
    const result = await sandbox.runBootstrap({
      baseUrl: cdn.cliArtifactBaseUrl(),
      approvedVersion: 'latest',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('invalid format');
    expect(requestedPaths()).toEqual([]);
    expect(existsSync(sandbox.binaryPath)).toBe(false);
  });

  it('rejects a plain-http, non-loopback base URL before any download', async () => {
    const result = await sandbox.runBootstrap({ baseUrl: 'http://mirror.example.com/cli' });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('must be an https:// URL');
    expect(existsSync(sandbox.binaryPath)).toBe(false);
  });

  it('aborts on a checksum mismatch and installs nothing', async () => {
    cdn.publishCliArtifact(RUNNER_VERSION, runnerBytes, { checksum: MISMATCHED_CHECKSUM });

    const result = await sandbox.runBootstrap({ baseUrl: cdn.cliArtifactBaseUrl() });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('SHA256 mismatch');
    expect(existsSync(sandbox.binaryPath)).toBe(false);
  });

  it('aborts when the checksum file is missing and installs nothing', async () => {
    cdn.publishCliArtifact(RUNNER_VERSION, runnerBytes, { checksum: null });

    const result = await sandbox.runBootstrap({ baseUrl: cdn.cliArtifactBaseUrl() });

    expect(result.exitCode).not.toBe(0);
    expect(existsSync(sandbox.binaryPath)).toBe(false);
  });

  it('aborts when the version is not published', async () => {
    const result = await sandbox.runBootstrap({
      baseUrl: cdn.cliArtifactBaseUrl(),
      approvedVersion: '1.1.1',
    });

    expect(result.exitCode).not.toBe(0);
    expect(existsSync(sandbox.binaryPath)).toBe(false);
  });

  it('removes its temporary runner on success and on failure', async () => {
    cdn.publishCliArtifact(RUNNER_VERSION, runnerBytes);
    cdn.publishCliArtifact('8.8.8', runnerBytes, { checksum: MISMATCHED_CHECKSUM });

    await sandbox.runBootstrap({ baseUrl: cdn.cliArtifactBaseUrl() });
    const afterSuccess = sandbox.leftoverDownloads();
    await sandbox.runBootstrap({
      baseUrl: cdn.cliArtifactBaseUrl(),
      approvedVersion: '8.8.8',
    });

    expect(afterSuccess).toEqual([]);
    expect(sandbox.leftoverDownloads()).toEqual([]);
  });

  it.skipIf(SKIP_ON_WINDOWS)(
    'falls back to the .exe artifact published before the .bin convention',
    async () => {
      cdn.publishCliArtifact(RUNNER_VERSION, runnerBytes, { suffix: '.exe' });

      const result = await sandbox.runBootstrap({ baseUrl: cdn.cliArtifactBaseUrl() });

      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(isRealCli(sandbox.binaryPath)).toBe(true);
    },
  );
});

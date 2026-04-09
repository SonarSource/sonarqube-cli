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

// Unit tests for resolveSecretsBinary (sonar-secrets binary download and setup)

import { mock, describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../src/ui';
import * as processLib from '../../src/lib/process.js';
import * as stateManager from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';
import {
  SONARSOURCE_BINARIES_URL,
  SONAR_SECRETS_DIST_PREFIX,
} from '../../src/lib/config-constants.js';
import { detectPlatform } from '../../src/lib/platform-detector.js';
import { SONAR_SECRETS_VERSION } from '../../src/lib/signatures.js';
import { buildLocalBinaryName } from '../../src/cli/commands/_common/install/secrets';

// Import the real module first, then register it as a mock with the same object.
// Because mock.module returns a plain mutable object (not a frozen ES namespace),
// spyOn can patch individual exports per-test and restore them in afterEach —
// without permanently replacing any function for other test files in this process.
const releases = await import('../../src/lib/sonarsource-releases.js');
void mock.module('../../src/lib/sonarsource-releases.js', () => ({
  ...releases,
  buildDownloadUrl: (version: string, platform: { os: string; arch: string }): string =>
    `${SONARSOURCE_BINARIES_URL}/${SONAR_SECRETS_DIST_PREFIX}/sonar-secrets-${version}-${platform.os}-${platform.arch}.exe`,
}));

const { resolveSecretsBinary } = await import('../../src/cli/commands/_common/install/secrets.js');

// =============================================================================
// SECTION: resolveSecretsBinary — happy path
// =============================================================================

describe('resolveSecretsBinary: happy path', () => {
  let downloadBinarySpy: ReturnType<typeof spyOn>;
  let verifyBinarySignatureSpy: ReturnType<typeof spyOn>;
  let spawnSpy: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let tempBinDir: string;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    tempBinDir = join(tmpdir(), `sonar-install-test-${Date.now()}`);
    mkdirSync(tempBinDir, { recursive: true });
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
    downloadBinarySpy = spyOn(releases, 'downloadBinary').mockImplementation(
      (_url: string, path: string) => {
        writeFileSync(path, '');
        return Promise.resolve();
      },
    );
    verifyBinarySignatureSpy = spyOn(releases, 'verifyBinarySignature').mockResolvedValue(
      undefined,
    );
    spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: `sonar-secrets ${SONAR_SECRETS_VERSION}\n`,
      stderr: '',
    });
  });

  afterEach(() => {
    downloadBinarySpy.mockRestore();
    verifyBinarySignatureSpy.mockRestore();
    spawnSpy.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
    rmSync(tempBinDir, { recursive: true, force: true });
  });

  it('returns freshlyInstalled: true and binaryPath when install succeeds', async () => {
    const result = await resolveSecretsBinary({ force: true }, { binDir: tempBinDir });

    expect(result.freshlyInstalled).toBe(true);
    expect(result.binaryPath).toContain('sonar-secrets');
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
  });

  it('returns freshlyInstalled: false when binary is already at the correct version', async () => {
    // Arrange: binary already exists at pinned version
    const binaryPath = join(tempBinDir, buildLocalBinaryName(detectPlatform()));
    writeFileSync(binaryPath, '');

    const result = await resolveSecretsBinary({ force: false }, { binDir: tempBinDir });

    expect(result.freshlyInstalled).toBe(false);
    expect(downloadBinarySpy).not.toHaveBeenCalled();
  });

  it('removes old versioned binaries after a successful install', async () => {
    // Arrange: two stale binaries for the current platform
    const platform = detectPlatform();
    const oldBinary1 = join(
      tempBinDir,
      `sonar-secrets-0.0.0.1-${platform.os}-${platform.arch}${platform.extension}`,
    );
    const oldBinary2 = join(
      tempBinDir,
      `sonar-secrets-1.2.3.4-${platform.os}-${platform.arch}${platform.extension}`,
    );
    writeFileSync(oldBinary1, '');
    writeFileSync(oldBinary2, '');

    await resolveSecretsBinary({ force: true }, { binDir: tempBinDir });

    expect(existsSync(oldBinary1)).toBe(false);
    expect(existsSync(oldBinary2)).toBe(false);
    // New versioned binary is present
    expect(readdirSync(tempBinDir).filter((f) => f.startsWith('sonar-secrets-'))).toHaveLength(1);
  });
});

// =============================================================================
// SECTION: resolveSecretsBinary — error paths
// =============================================================================

describe('resolveSecretsBinary: error paths', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let downloadBinarySpy: ReturnType<typeof spyOn>;
  let verifyBinarySignatureSpy: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let tempBinDir: string;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    tempBinDir = join(tmpdir(), `sonar-install-err-${Date.now()}`);
    mkdirSync(tempBinDir, { recursive: true });
  });

  afterEach(() => {
    spawnSpy?.mockRestore();
    downloadBinarySpy?.mockRestore();
    verifyBinarySignatureSpy?.mockRestore();
    loadStateSpy?.mockRestore();
    saveStateSpy?.mockRestore();
    setMockUi(false);
    rmSync(tempBinDir, { recursive: true, force: true });
  });

  it('throws when signature verification fails', async () => {
    downloadBinarySpy = spyOn(releases, 'downloadBinary').mockImplementation(
      (_url: string, path: string) => {
        writeFileSync(path, '');
        return Promise.resolve();
      },
    );
    verifyBinarySignatureSpy = spyOn(releases, 'verifyBinarySignature').mockRejectedValue(
      new Error('bad signature'),
    );

    let error: unknown;
    try {
      await resolveSecretsBinary({ force: true }, { binDir: tempBinDir });
    } catch (err) {
      error = err;
    }

    expect((error as Error).message).toBe('bad signature');
  });

  it('throws with verification error when binary does not respond after download', async () => {
    // Arrange: download + signature pass, but binary does not respond to --version
    downloadBinarySpy = spyOn(releases, 'downloadBinary').mockImplementation(
      (_url: string, path: string) => {
        writeFileSync(path, '');
        return Promise.resolve();
      },
    );
    verifyBinarySignatureSpy = spyOn(releases, 'verifyBinarySignature').mockResolvedValue(
      undefined,
    );
    spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'not working',
    });

    let caughtError: unknown;
    try {
      await resolveSecretsBinary({ force: true }, { binDir: tempBinDir });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    expect((caughtError as Error).message).toMatch(/verification|not responding/i);
  });

  it('completes install and warns when state save fails', async () => {
    // Arrange: full install succeeds but state persistence throws
    downloadBinarySpy = spyOn(releases, 'downloadBinary').mockImplementation(
      (_url: string, path: string) => {
        writeFileSync(path, '');
        return Promise.resolve();
      },
    );
    verifyBinarySignatureSpy = spyOn(releases, 'verifyBinarySignature').mockResolvedValue(
      undefined,
    );
    spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: `sonar-secrets ${SONAR_SECRETS_VERSION}\n`,
      stderr: '',
    });
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {
      throw new Error('disk full');
    });

    // Act: should not throw despite state error
    const result = await resolveSecretsBinary({ force: true }, { binDir: tempBinDir });

    // Assert: install succeeded; user is warned but not blocked
    const warns = getMockUiCalls()
      .filter((c) => c.method === 'warn')
      .map((c) => String(c.args[0]));
    expect(result.freshlyInstalled).toBe(true);
    expect(warns.some((m) => m.includes('Failed to update state'))).toBe(true);
  });

  describe('buildLocalBinaryName', () => {
    it('should include version in the name for linux', () => {
      const platform = { os: 'linux', arch: 'x86-64', extension: '' };
      expect(buildLocalBinaryName(platform)).toBe(
        `sonar-secrets-${SONAR_SECRETS_VERSION}-linux-x86-64`,
      );
    });

    it('should include version and .exe extension for windows', () => {
      const platform = { os: 'windows', arch: 'x86-64', extension: '.exe' };
      expect(buildLocalBinaryName(platform)).toBe(
        `sonar-secrets-${SONAR_SECRETS_VERSION}-windows-x86-64.exe`,
      );
    });

    it('should include version for macos arm64', () => {
      const platform = { os: 'macos', arch: 'arm64', extension: '' };
      expect(buildLocalBinaryName(platform)).toBe(
        `sonar-secrets-${SONAR_SECRETS_VERSION}-macos-arm64`,
      );
    });
  });
});

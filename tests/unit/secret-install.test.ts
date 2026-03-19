/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Unit tests for sonar secret install command

import { mock, describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../src/ui';
import * as processLib from '../../src/lib/process.js';
import * as stateManager from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';
import { CommandFailedError } from '../../src/cli/commands/_common/error.js';
import {
  BIN_DIR,
  SONARSOURCE_BINARIES_URL,
  SONAR_SECRETS_DIST_PREFIX,
} from '../../src/lib/config-constants.js';
import { buildLocalBinaryName, detectPlatform } from '../../src/lib/platform-detector.js';
import { SONAR_SECRETS_VERSION } from '../../src/lib/signatures.js';

// Import the real module first, then register it as a mock with the same object.
// Because mock.module returns a plain mutable object (not a frozen ES namespace),
// spyOn can patch individual exports per-test and restore them in afterEach —
// without permanently replacing any function for other test files in this process.
const releases = await import('../../src/lib/sonarsource-releases.js');
void mock.module('../../src/lib/sonarsource-releases.js', () => ({
  ...releases,
  // Override buildDownloadUrl with a deterministic version so tests don't depend
  // on config-constants and sonarsource-releases.test.ts is not contaminated.
  buildDownloadUrl: (version: string, platform: { os: string; arch: string }): string =>
    `${SONARSOURCE_BINARIES_URL}/${SONAR_SECRETS_DIST_PREFIX}/sonar-secrets-${version}-${platform.os}-${platform.arch}.exe`,
}));

const { installSecrets } = await import('../../src/cli/commands/install/secrets');

describe('secretInstallCommand', () => {
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let downloadBinarySpy: ReturnType<typeof spyOn>;
  let verifyBinarySignatureSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
    // Default: download succeeds silently, signature verification fails
    downloadBinarySpy = spyOn(releases, 'downloadBinary').mockResolvedValue(undefined);
    verifyBinarySignatureSpy = spyOn(releases, 'verifyBinarySignature').mockRejectedValue(
      new Error('signature unavailable'),
    );
  });

  afterEach(() => {
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    downloadBinarySpy.mockRestore();
    verifyBinarySignatureSpy.mockRestore();
    setMockUi(false);
  });

  it('throws when binary installation fails', () => {
    // Default verifyBinarySignatureSpy rejects → install fails
    expect(installSecrets({ force: true })).rejects.toThrow();
  });

  it('exits 0 when installation succeeds', async () => {
    const tempBinDir = join(tmpdir(), `sonar-install-test-${Date.now()}`);

    downloadBinarySpy.mockImplementation((_url: string, path: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ''); // empty placeholder so chmod in makeExecutable succeeds
      return Promise.resolve();
    });
    verifyBinarySignatureSpy.mockResolvedValue(undefined);

    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: `sonar-secrets version ${SONAR_SECRETS_VERSION}\n`,
      stderr: '',
    });

    try {
      await installSecrets({ force: true }, { binDir: tempBinDir });
    } finally {
      spawnSpy.mockRestore();
      rmSync(tempBinDir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// SECTION: performSecretInstall — version check paths
// =============================================================================

describe('performSecretInstall: version check paths', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let downloadBinarySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    spawnSpy?.mockRestore();
    downloadBinarySpy?.mockRestore();
    setMockUi(false);
  });

  it('shows "Updating..." and triggers fresh download when installed version differs from pinned', async () => {
    // Arrange
    const tempBinDir = join(tmpdir(), `sonar-outdated-${Date.now()}`);
    mkdirSync(tempBinDir, { recursive: true });
    writeFileSync(join(tempBinDir, buildLocalBinaryName(detectPlatform())), '');
    spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: 'sonar-secrets 1.0.0\n',
      stderr: '',
    });
    // Installed version differs from pinned → update triggered; abort at download to keep test fast
    downloadBinarySpy = spyOn(releases, 'downloadBinary').mockRejectedValue(
      new Error('abort install'),
    );

    let caughtError: unknown;
    try {
      await installSecrets({}, { binDir: tempBinDir });
    } catch (err) {
      caughtError = err;
    } finally {
      rmSync(tempBinDir, { recursive: true, force: true });
    }

    // Assert: the "Updating..." message must have been shown before the download was triggered
    const texts = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(caughtError).toBeDefined(); // install aborted by mock
    expect(texts.some((m) => m.includes('Updating'))).toBe(true);
  });

  it('triggers fresh install when existing binary fails version check', async () => {
    // Arrange
    const tempBinDir = join(tmpdir(), `sonar-vcheckfail-${Date.now()}`);
    mkdirSync(tempBinDir, { recursive: true });
    writeFileSync(join(tempBinDir, buildLocalBinaryName(detectPlatform())), '');
    spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: '',
    });
    // Binary broken → existing check skipped → download attempted; abort to keep test fast
    downloadBinarySpy = spyOn(releases, 'downloadBinary').mockRejectedValue(
      new Error('abort install'),
    );

    let caughtError: unknown;
    try {
      await installSecrets({}, { binDir: tempBinDir });
    } catch (err) {
      caughtError = err;
    } finally {
      rmSync(tempBinDir, { recursive: true, force: true });
    }

    // Assert: install was attempted — downloadBinary was called
    expect(caughtError).toBeDefined(); // install aborted by mock
    expect(downloadBinarySpy).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// SECTION: secretInstallCommand — installation error paths
// =============================================================================

describe('secretInstallCommand: installation error paths', () => {
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

  it('reports verification failure message when binary does not respond after download', async () => {
    // Arrange
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

    // Act
    let caughtError: unknown;
    try {
      await installSecrets({ force: true }, { binDir: tempBinDir });
    } catch (err) {
      caughtError = err;
    }

    // Assert: signature passes but --version fails → throws with verification error
    expect(caughtError).toBeDefined();
    expect((caughtError as Error).message).toMatch(/verification|not responding/i);
    expect(verifyBinarySignatureSpy).toHaveBeenCalledWith(
      expect.stringContaining('sonar-secrets'),
      expect.objectContaining({ os: expect.any(String) }),
      expect.any(Object),
      expect.any(String),
    );
  });

  it('completes install successfully and warns about state save failure when state file is unwritable', async () => {
    // Arrange
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

    // Act
    await installSecrets({ force: true }, { binDir: tempBinDir });

    // Assert: install succeeds despite state error; user is warned but not blocked
    const successes = getMockUiCalls()
      .filter((c) => c.method === 'success')
      .map((c) => String(c.args[0]));
    const warns = getMockUiCalls()
      .filter((c) => c.method === 'warn')
      .map((c) => String(c.args[0]));
    expect(successes.some((m) => m.includes('Installation complete'))).toBe(true);
    expect(warns.some((m) => m.includes('Failed to update state'))).toBe(true);
  });
});

// =============================================================================
// SECTION: secretStatusCommand
// =============================================================================

describe('secretStatusCommand', () => {
  let existsSyncSpy: ReturnType<typeof spyOn>;
  let spawnSpy: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
  });

  afterEach(() => {
    existsSyncSpy?.mockRestore();
    spawnSpy?.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('shows binary-not-working message and throws when version check fails', async () => {
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: '',
    });

    let caughtError: unknown;
    try {
      await installSecrets({ status: true });
    } catch (err) {
      caughtError = err;
    }

    const expectedBinaryPath = join(BIN_DIR, buildLocalBinaryName(detectPlatform()));
    expect(caughtError).toBeInstanceOf(CommandFailedError);
    expect((caughtError as CommandFailedError).message).toBe(
      `Binary is installed but could not be called.\nPath: ${expectedBinaryPath}\n  Reinstall with: sonar install secrets --force`,
    );
  });
});

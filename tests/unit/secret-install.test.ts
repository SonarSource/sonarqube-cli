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
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockUi } from '../../src/ui';
import { detectPlatform } from '../../src/lib/platform-detector.js';
import * as processLib from '../../src/lib/process.js';
import * as stateManager from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';
import { SONARSOURCE_BINARIES_URL, SONAR_SECRETS_DIST_PREFIX } from '../../src/lib/config-constants.js';

// Configurable mock implementations — changed per test as needed
let mockFetchLatestVersion: () => Promise<string> = async () => {
  throw new Error('network unavailable');
};
let mockDownloadBinary: (url: string, path: string) => Promise<void> = async () => {};

// Mock sonarsource-releases module BEFORE importing secret.ts (which depends on it).
// buildDownloadUrl uses the real implementation to avoid contaminating sonarsource-releases.test.ts,
// since Bun shares the module registry across test files in the same process.
mock.module('../../src/lib/sonarsource-releases.js', () => ({
  fetchLatestVersion: () => mockFetchLatestVersion(),
  buildDownloadUrl: (version: string, platform: { os: string; arch: string }): string =>
    `${SONARSOURCE_BINARIES_URL}/${SONAR_SECRETS_DIST_PREFIX}/sonar-secrets-${version}-${platform.os}-${platform.arch}.exe`,
  downloadBinary: (url: string, path: string) => mockDownloadBinary(url, path),
}));

const { secretInstallCommand } = await import('../../src/commands/secret.js');

describe('secretInstallCommand', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
    // Reset mock implementations to default (failing)
    mockFetchLatestVersion = async () => { throw new Error('network unavailable'); };
    mockDownloadBinary = async () => {};
  });

  it('exits 1 when binary installation fails', async () => {
    await secretInstallCommand({ force: true });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 0 when installation succeeds', async () => {
    const tempBinDir = join(tmpdir(), `sonar-install-test-${Date.now()}`);
    const platform = detectPlatform();
    const version = '1.0.0';

    mockFetchLatestVersion = async () => version;

    mockDownloadBinary = async (_url: string, path: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ''); // empty placeholder so chmod in makeExecutable succeeds
    };

    // spyOn so verifyInstallation returns a version without executing the binary
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0, stdout: `sonar-secrets version ${version}\n`, stderr: '',
    });

    try {
      await secretInstallCommand({ force: true }, { binDir: tempBinDir });
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      spawnSpy.mockRestore();
      rmSync(tempBinDir, { recursive: true, force: true });
    }
  });
});

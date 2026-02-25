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
import * as processLib from '../../src/lib/process.js';
import * as stateManager from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';
import { SONARSOURCE_BINARIES_URL, SONAR_SECRETS_DIST_PREFIX } from '../../src/lib/config-constants.js';

// Import the real module first, then register it as a mock with the same object.
// Because mock.module returns a plain mutable object (not a frozen ES namespace),
// spyOn can patch individual exports per-test and restore them in afterEach —
// without permanently replacing any function for other test files in this process.
const releases = await import('../../src/lib/sonarsource-releases.js');
mock.module('../../src/lib/sonarsource-releases.js', () => ({
  ...releases,
  // Override buildDownloadUrl with a deterministic version so tests don't depend
  // on config-constants and sonarsource-releases.test.ts is not contaminated.
  buildDownloadUrl: (version: string, platform: { os: string; arch: string }): string =>
    `${SONARSOURCE_BINARIES_URL}/${SONAR_SECRETS_DIST_PREFIX}/sonar-secrets-${version}-${platform.os}-${platform.arch}.exe`,
}));

const { secretInstallCommand } = await import('../../src/commands/secret.js');

describe('secretInstallCommand', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let downloadBinarySpy: ReturnType<typeof spyOn>;
  let verifyBinarySignatureSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
    // Default: download succeeds silently, signature verification fails
    downloadBinarySpy = spyOn(releases, 'downloadBinary').mockResolvedValue(undefined);
    verifyBinarySignatureSpy = spyOn(releases, 'verifyBinarySignature').mockRejectedValue(
      new Error('signature unavailable')
    );
  });

  afterEach(() => {
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    downloadBinarySpy.mockRestore();
    verifyBinarySignatureSpy.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when binary installation fails', async () => {
    // Default verifyBinarySignatureSpy rejects → install fails
    await secretInstallCommand({ force: true });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 0 when installation succeeds', async () => {
    const tempBinDir = join(tmpdir(), `sonar-install-test-${Date.now()}`);
    const { SONAR_SECRETS_VERSION } = await import('../../src/lib/signatures.js');

    downloadBinarySpy.mockImplementation(async (_url: string, path: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, ''); // empty placeholder so chmod in makeExecutable succeeds
    });
    verifyBinarySignatureSpy.mockResolvedValue(undefined);

    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0, stdout: `sonar-secrets version ${SONAR_SECRETS_VERSION}\n`, stderr: '',
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

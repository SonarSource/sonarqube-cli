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

// Unit tests for sonar secret command

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectPlatform,
  buildAssetName,
  buildLocalBinaryName,
} from '../../src/lib/platform-detector.js';
import { installSecretScanningHooks } from '../../src/bootstrap/hooks.js';
import {
  secretCheckCommand,
  secretInstallCommand,
  secretStatusCommand,
  performSecretInstall,
} from '../../src/commands/secret.js';
import * as releases from '../../src/lib/sonarsource-releases.js';
import { SONAR_SECRETS_VERSION } from '../../src/lib/signatures.js';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui';
import * as processLib from '../../src/lib/process.js';
import * as stateManager from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';
import { saveToken } from '../../src/lib/keychain.js';
import { createMockKeytar } from '../helpers/mock-keytar.js';
import type { PlatformInfo } from '../../src/lib/install-types.js';

// =============================================================================
// SECTION 1: Platform Detection and Binary Naming (no setup)
// =============================================================================

describe('Platform Detection and Binary Naming', () => {
  it('detectPlatform: returns valid OS and architecture from current system', () => {
    const platform = detectPlatform();

    expect(platform).toBeDefined();
    expect(platform.os).toBeDefined();
    expect(platform.arch).toBeDefined();
    expect(['macos', 'linux', 'windows']).toContain(platform.os);
    expect(['x86-64', 'arm64', 'arm', '386']).toContain(platform.arch);
    expect(typeof platform.extension).toBe('string');
  });

  it('buildAssetName: generates correct GitHub release asset names for all platforms/architectures', () => {
    const linuxX64 = buildAssetName('1.0.0', { os: 'linux', arch: 'x86-64', extension: '' });
    expect(linuxX64).toBe('sonar-secrets-1.0.0-linux-x86-64');

    const windowsExe = buildAssetName('1.0.0', {
      os: 'windows',
      arch: 'x86-64',
      extension: '.exe',
    });
    expect(windowsExe).toBe('sonar-secrets-1.0.0-windows-x86-64.exe');

    const versionWithV = buildAssetName('v2.1.0', { os: 'linux', arch: 'x86-64', extension: '' });
    expect(versionWithV).toContain('2.1.0');
    expect(versionWithV).not.toContain('v2.1.0');
  });

  it('buildLocalBinaryName: generates local filenames without version or path separators', () => {
    const unixBinary = buildLocalBinaryName({ os: 'linux', arch: 'x86-64', extension: '' });
    expect(unixBinary).toBe('sonar-secrets');

    const windowsBinary = buildLocalBinaryName({
      os: 'windows',
      arch: 'x86-64',
      extension: '.exe',
    });
    expect(windowsBinary).toBe('sonar-secrets.exe');
  });

  it('All OS and architecture combinations produce valid asset names', () => {
    const osList = ['linux', 'darwin', 'windows'];
    const archList = ['x86-64', 'arm64'];

    osList.forEach((os) => {
      archList.forEach((arch) => {
        const platform: PlatformInfo = {
          os: os as unknown as PlatformInfo['os'],
          arch: arch as unknown as PlatformInfo['arch'],
          extension: os === 'windows' ? '.exe' : '',
        };

        const assetName = buildAssetName('1.0.0', platform);
        const localName = buildLocalBinaryName(platform);

        expect(assetName).toContain('sonar-secrets');
        expect(assetName).toContain(os);
        expect(assetName).toContain(arch);
        expect(localName).toBe('sonar-secrets' + platform.extension);
      });
    });
  });
});

// =============================================================================
// SECTION 2: Secret Scanning Hooks Installation
// =============================================================================

describe('installSecretScanningHooks', () => {
  let testProjectRoot: string;
  let claudeDir: string;
  let settingsPath: string;

  beforeEach(() => {
    testProjectRoot = join(tmpdir(), `test-secret-hooks-${Date.now()}`);
    claudeDir = join(testProjectRoot, '.claude');
    settingsPath = join(claudeDir, 'settings.json');
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testProjectRoot)) {
      rmSync(testProjectRoot, { recursive: true, force: true });
    }
  });

  it('creates PreToolUse hook pointing to pretool-secrets script', async () => {
    await installSecretScanningHooks(testProjectRoot);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Read');
    expect(settings.hooks.PreToolUse[0].hooks[0].type).toBe('command');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('pretool-secrets');
  });

  it('creates UserPromptSubmit hook pointing to prompt-secrets script', async () => {
    await installSecretScanningHooks(testProjectRoot);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.hooks.UserPromptSubmit[0].matcher).toBe('*');
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain('prompt-secrets');
  });

  it('creates hook build-scripts on disk', async () => {
    await installSecretScanningHooks(testProjectRoot);

    const scriptsDir = join(claudeDir, 'hooks', 'sonar-secrets', 'build-scripts');
    expect(existsSync(scriptsDir)).toBe(true);

    const ext = process.platform === 'win32' ? '.ps1' : '.sh';
    expect(existsSync(join(scriptsDir, `pretool-secrets${ext}`))).toBe(true);
    expect(existsSync(join(scriptsDir, `prompt-secrets${ext}`))).toBe(true);
  });

  it('preserves existing hooks when adding secret scanning hooks', async () => {
    const existingSettings = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [{ type: 'command', command: '.claude/hooks/sonar-prompt.sh', timeout: 120 }],
          },
        ],
      },
    };

    const fs = await import('node:fs/promises');
    await fs.writeFile(settingsPath, JSON.stringify(existingSettings, null, 2));

    await installSecretScanningHooks(testProjectRoot);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
  });

  it('hook timeouts are 60 seconds', async () => {
    await installSecretScanningHooks(testProjectRoot);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const EXPECTED_TIMEOUT = 60;
    expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(EXPECTED_TIMEOUT);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(EXPECTED_TIMEOUT);
  });
});

// =============================================================================
// SECTION 4: secretCheckCommand
// =============================================================================

describe('secretCheckCommand', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  const keytarHandle = createMockKeytar();

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
  });

  afterEach(() => {
    keytarHandle.teardown();
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when called without --file or --stdin', async () => {
    await secretCheckCommand({});
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 with install hint when sonar-secrets binary is missing', async () => {
    const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);

    clearMockUiCalls();
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSyncSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const uiCalls = getMockUiCalls();
    const errorMessages = uiCalls.filter((c) => c.method === 'error').map((c) => String(c.args[0]));
    const textMessages = uiCalls.filter((c) => c.method === 'text').map((c) => String(c.args[0]));
    expect(errorMessages.some((m) => m.includes('sonar-secrets is not installed'))).toBe(true);
    expect(textMessages.some((m) => m.includes('sonar install secrets'))).toBe(true);
  });

  it('exits 1 when --file and --stdin are both provided', async () => {
    await secretCheckCommand({ file: 'some-file.ts', stdin: true });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 with file-not-found message when --file points to nonexistent path', async () => {
    // Set up state with an active connection
    const state = getDefaultState('test');
    stateManager.addOrUpdateConnection(state, 'https://sonarcloud.io', 'cloud', {
      orgKey: 'test-org',
      keystoreKey: 'sonarcloud.io:test-org',
    });
    loadStateSpy.mockReturnValue(state);

    // Provide a token in the mock keychain
    await saveToken('https://sonarcloud.io', 'mock-token', 'test-org');

    // Make binary existence check pass, file existence check fail
    const existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((p) =>
      String(p).includes('sonar-secrets'),
    );

    clearMockUiCalls();
    try {
      await secretCheckCommand({ file: '/nonexistent/does-not-exist.ts' });
    } finally {
      existsSyncSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const errors = getMockUiCalls()
      .filter((c) => c.method === 'error')
      .map((c) => String(c.args[0]));
    expect(errors.some((m) => m.includes('File not found'))).toBe(true);
  });
});

// =============================================================================
// SECTION 5: performSecretInstall — checkExistingInstallation paths
// =============================================================================

describe('performSecretInstall: already up to date', () => {
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

  it('returns the installed binary path without downloading when binary is already at pinned version', async () => {
    // Arrange
    const pinnedVersion = SONAR_SECRETS_VERSION;
    const tempBinDir = join(tmpdir(), `sonar-uptodate-${Date.now()}`);
    mkdirSync(tempBinDir, { recursive: true });
    const expectedBinaryPath = join(tempBinDir, buildLocalBinaryName(detectPlatform()));
    writeFileSync(expectedBinaryPath, '');
    spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: `sonar-secrets ${pinnedVersion}\n`,
      stderr: '',
    });

    try {
      // Act
      const result = await performSecretInstall({}, { binDir: tempBinDir });

      // Assert
      expect(result).toBe(expectedBinaryPath);
      const texts = getMockUiCalls()
        .filter((c) => c.method === 'text')
        .map((c) => String(c.args[0]));
      expect(texts.some((m) => m.includes('already installed (latest)'))).toBe(true);
    } finally {
      rmSync(tempBinDir, { recursive: true, force: true });
    }
  });

  it('shows "Updating..." and triggers fresh download when installed version differs from pinned', async () => {
    // Arrange
    const mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
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

    try {
      // Act
      await secretInstallCommand({}, { binDir: tempBinDir });

      // Assert: the "Updating..." message must have been shown before the download was triggered
      const texts = getMockUiCalls()
        .filter((c) => c.method === 'text')
        .map((c) => String(c.args[0]));
      expect(mockExit).toHaveBeenCalledWith(1); // install aborted by mock
      expect(texts.some((m) => m.includes('Updating'))).toBe(true);
    } finally {
      mockExit.mockRestore();
      rmSync(tempBinDir, { recursive: true, force: true });
    }
  });

  it('triggers fresh install when existing binary fails version check', async () => {
    // Arrange
    const mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
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

    try {
      // Act
      await secretInstallCommand({}, { binDir: tempBinDir });

      // Assert: install was attempted — downloadBinary was called
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(downloadBinarySpy).toHaveBeenCalledTimes(1);
    } finally {
      mockExit.mockRestore();
      rmSync(tempBinDir, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// SECTION 6: secretInstallCommand — installation error paths
// =============================================================================

describe('secretInstallCommand: installation error paths', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let spawnSpy: ReturnType<typeof spyOn>;
  let downloadBinarySpy: ReturnType<typeof spyOn>;
  let verifyBinarySignatureSpy: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let tempBinDir: string;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    tempBinDir = join(tmpdir(), `sonar-install-err-${Date.now()}`);
    mkdirSync(tempBinDir, { recursive: true });
  });

  afterEach(() => {
    mockExit.mockRestore();
    spawnSpy?.mockRestore();
    downloadBinarySpy?.mockRestore();
    verifyBinarySignatureSpy?.mockRestore();
    loadStateSpy?.mockRestore();
    saveStateSpy?.mockRestore();
    setMockUi(false);
    if (existsSync(tempBinDir)) rmSync(tempBinDir, { recursive: true, force: true });
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
    await secretInstallCommand({ force: true }, { binDir: tempBinDir });

    // Assert: signature passes but --version fails → exits 1 with verification error
    const errors = getMockUiCalls()
      .filter((c) => c.method === 'error')
      .map((c) => String(c.args[0]));
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(errors.some((m) => m.includes('verification') || m.includes('not responding'))).toBe(
      true,
    );
    expect(verifyBinarySignatureSpy).toHaveBeenCalledWith(
      expect.stringContaining('sonar-secrets'),
      expect.objectContaining({ os: expect.any(String) }),
      expect.any(Object),
      expect.any(String),
    );
  });

  it('completes install successfully and warns about state save failure when state file is unwritable', async () => {
    // Arrange
    const pinnedVersion = SONAR_SECRETS_VERSION;
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
      stdout: `sonar-secrets ${pinnedVersion}\n`,
      stderr: '',
    });
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {
      throw new Error('disk full');
    });

    // Act
    await secretInstallCommand({ force: true }, { binDir: tempBinDir });

    // Assert: install succeeds despite state error; user is warned but not blocked
    const successes = getMockUiCalls()
      .filter((c) => c.method === 'success')
      .map((c) => String(c.args[0]));
    const warns = getMockUiCalls()
      .filter((c) => c.method === 'warn')
      .map((c) => String(c.args[0]));
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(successes.some((m) => m.includes('Installation complete'))).toBe(true);
    expect(warns.some((m) => m.includes('Failed to update state'))).toBe(true);
  });
});

// =============================================================================
// SECTION 6: secretStatusCommand
// =============================================================================

describe('secretStatusCommand', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
  });

  afterEach(() => {
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('shows not-installed message and install hint when binary is missing', async () => {
    const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(false);
    try {
      await secretStatusCommand();
    } finally {
      existsSyncSpy.mockRestore();
    }

    const texts = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(texts.some((m) => m.includes('Not installed'))).toBe(true);
    expect(texts.some((m) => m.includes('sonar install secrets'))).toBe(true);
  });

  it('shows binary-not-working message and exits 1 when version check fails', async () => {
    const existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: '',
    });
    try {
      await secretStatusCommand();
    } finally {
      existsSyncSpy.mockRestore();
      spawnSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const texts = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(texts.some((m) => m.includes('sonar install secrets --force'))).toBe(true);
  });
});

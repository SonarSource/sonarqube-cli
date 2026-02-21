// Unit tests for sonar secret command

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectPlatform, buildAssetName, buildLocalBinaryName } from '../../src/lib/platform-detector.js';
import { installSecretScanningHooks } from '../../src/bootstrap/hooks.js';
import { secretStatusCommand, secretCheckCommand } from '../../src/commands/secret.js';
import { setMockUi } from '../../src/ui';
import * as processLib from '../../src/lib/process.js';
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

    const windowsExe = buildAssetName('1.0.0', { os: 'windows', arch: 'x86-64', extension: '.exe' });
    expect(windowsExe).toBe('sonar-secrets-1.0.0-windows-x86-64.exe');

    const versionWithV = buildAssetName('v2.1.0', { os: 'linux', arch: 'x86-64', extension: '' });
    expect(versionWithV).toContain('2.1.0');
    expect(versionWithV).not.toContain('v2.1.0');
  });

  it('buildLocalBinaryName: generates local filenames without version or path separators', () => {
    const unixBinary = buildLocalBinaryName({ os: 'linux', arch: 'x86-64', extension: '' });
    expect(unixBinary).toBe('sonar-secrets');

    const windowsBinary = buildLocalBinaryName({ os: 'windows', arch: 'x86-64', extension: '.exe' });
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
          extension: os === 'windows' ? '.exe' : ''
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

  it('creates hook scripts on disk', async () => {
    await installSecretScanningHooks(testProjectRoot);

    const scriptsDir = join(claudeDir, 'hooks', 'sonar-secrets', 'scripts');
    expect(existsSync(scriptsDir)).toBe(true);

    const ext = process.platform === 'win32' ? '.ps1' : '.sh';
    expect(existsSync(join(scriptsDir, `pretool-secrets${ext}`))).toBe(true);
    expect(existsSync(join(scriptsDir, `prompt-secrets${ext}`))).toBe(true);
  });

  it('preserves existing hooks when adding secret scanning hooks', async () => {
    const existingSettings = {
      hooks: {
        PostToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: '.claude/hooks/sonar-prompt.sh', timeout: 120 }] }
        ]
      }
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
// SECTION 3: secretStatusCommand
// =============================================================================

describe('secretStatusCommand', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockExit: any;
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
  });

  afterEach(() => {
    mockExit.mockRestore();
    spawnSpy.mockRestore();
    setMockUi(false);
  });

  it('exits 0 when sonar-secrets binary is not installed', async () => {
    // Temp dir with no binary inside — existsSync returns false
    const tempBinDir = join(tmpdir(), `sonar-status-test-${Date.now()}`);
    await secretStatusCommand({ binDir: tempBinDir });
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when sonar-secrets binary exists but fails version check', async () => {
    const tempBinDir = join(tmpdir(), `sonar-status-test-${Date.now()}`);
    mkdirSync(tempBinDir, { recursive: true });
    const binaryPath = join(tempBinDir, buildLocalBinaryName(detectPlatform()));
    writeFileSync(binaryPath, ''); // placeholder so existsSync returns true; spawnSpy returns exit 1

    try {
      await secretStatusCommand({ binDir: tempBinDir });
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      rmSync(tempBinDir, { recursive: true, force: true });
    }
  });
});


// =============================================================================
// SECTION 4: secretCheckCommand
// =============================================================================

describe('secretCheckCommand', () => {
  let mockExit: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when called without --file or --stdin', async () => {
    await secretCheckCommand({});
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

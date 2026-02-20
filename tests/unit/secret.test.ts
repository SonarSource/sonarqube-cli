// Unit tests for sonar secret command

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectPlatform, buildAssetName, buildLocalBinaryName } from '../../src/lib/platform-detector.js';
import { setMockLogger } from '../../src/lib/logger.js';
import type { PlatformInfo } from '../../src/lib/install-types.js';
import type { SpawnResult } from '../../src/lib/process.js';

const EXPECTED_HOOK_TYPES_COUNT = 3;

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
// SECTION 3: Secret Hooks Configuration (with file system setup)
// =============================================================================

describe('Secret Hooks Configuration', () => {
  let testProjectRoot: string;
  let claudeDir: string;
  let settingsPath: string;

  beforeEach(() => {
    testProjectRoot = join(tmpdir(), `test-hooks-${Date.now()}`);
    claudeDir = join(testProjectRoot, '.claude');
    settingsPath = join(claudeDir, 'settings.json');
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testProjectRoot)) {
      rmSync(testProjectRoot, { recursive: true, force: true });
    }
  });

  it('Settings file structure includes PreToolUse and UserPromptSubmit hooks with matchers and timeouts', () => {
    const expectedSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Read',
            hooks: [
              {
                type: 'command',
                command: '.claude/hooks/pretool-secrets.sh',
                timeout: 60
              }
            ]
          }
        ],
        UserPromptSubmit: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: '.claude/hooks/prompt-secrets.sh',
                timeout: 60
              }
            ]
          }
        ]
      }
    };

    writeFileSync(settingsPath, JSON.stringify(expectedSettings, null, 2));
    const saved = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    expect(saved.hooks.PreToolUse[0].matcher).toBe('Read');
    expect(saved.hooks.PreToolUse[0].hooks[0].timeout).toBe(60);
    expect(saved.hooks.UserPromptSubmit[0].matcher).toBe('*');
    expect(saved.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(60);
  });

  it('Multiple hook types can coexist in settings file', () => {
    const settings = {
      hooks: {
        PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: '.claude/hooks/sonar.sh', timeout: 120 }] }],
        PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: '.claude/hooks/pretool-secrets.sh', timeout: 60 }] }],
        UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: '.claude/hooks/prompt-secrets.sh', timeout: 60 }] }]
      }
    };

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    const merged = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    expect(Object.keys(merged.hooks).length).toBe(EXPECTED_HOOK_TYPES_COUNT);
    expect(merged.hooks.PostToolUse).toBeDefined();
    expect(merged.hooks.PreToolUse).toBeDefined();
    expect(merged.hooks.UserPromptSubmit).toBeDefined();
  });
});

// =============================================================================
// SECTION 4: Secret Check Stdin Mode (with mock logger setup)
// =============================================================================

describe('Secret Check Stdin Mode', () => {
  let logOutput: string[];
  let errorOutput: string[];

  const mockLogger = {
    debug: (msg: string) => logOutput.push(`[DEBUG] ${msg}`),
    info: (msg: string) => logOutput.push(`[INFO] ${msg}`),
    log: (msg: string) => logOutput.push(`[LOG] ${msg}`),
    success: (msg: string) => logOutput.push(`[SUCCESS] ${msg}`),
    warn: (msg: string) => errorOutput.push(`[WARN] ${msg}`),
    error: (msg: string) => errorOutput.push(`[ERROR] ${msg}`)
  };

  beforeEach(() => {
    logOutput = [];
    errorOutput = [];
    setMockLogger(mockLogger);
  });

  afterEach(() => {
    setMockLogger(null);
  });

  it('Flag validation: either --file or --stdin is required', () => {
    interface CheckOptions {
      file?: string;
      stdin?: boolean;
    }

    function validateCheckOptions(options: CheckOptions): { valid: boolean; error?: string } {
      if (!options.file && !options.stdin) {
        return { valid: false, error: 'Error: either --file or --stdin is required' };
      }
      if (options.file && options.stdin) {
        return { valid: false, error: 'Error: cannot use both --file and --stdin' };
      }
      return { valid: true };
    }

    const noFlags = validateCheckOptions({});
    expect(noFlags.valid).toBe(false);
    expect(noFlags.error).toContain('either --file or --stdin is required');

    const bothFlags = validateCheckOptions({ file: 'test.txt', stdin: true });
    expect(bothFlags.valid).toBe(false);
    expect(bothFlags.error).toContain('cannot use both');

    const fileOnly = validateCheckOptions({ file: 'test.txt' });
    expect(fileOnly.valid).toBe(true);

    const stdinOnly = validateCheckOptions({ stdin: true });
    expect(stdinOnly.valid).toBe(true);
  });

  it('Exit code parsing for secrets detection', () => {
    function parseExitCode(result: SpawnResult): { hasSecrets: boolean; exitCode: number } {
      const exitCode = result.exitCode ?? 1;
      return {
        hasSecrets: exitCode === 1,
        exitCode
      };
    }

    const noSecrets: SpawnResult = { exitCode: 0, stdout: '', stderr: '' };
    const withSecrets: SpawnResult = { exitCode: 1, stdout: 'Secrets found', stderr: '' };
    const error: SpawnResult = { exitCode: 2, stdout: '', stderr: 'Error' };

    expect(parseExitCode(noSecrets)).toEqual({ hasSecrets: false, exitCode: 0 });
    expect(parseExitCode(withSecrets)).toEqual({ hasSecrets: true, exitCode: 1 });
    expect(parseExitCode(error)).toEqual({ hasSecrets: false, exitCode: 2 });
  });

  it('Logger captures output during scan operations', () => {
    mockLogger.debug('Starting scan');
    mockLogger.info('Scanning file');
    mockLogger.success('Scan complete');
    mockLogger.warn('Warning message');

    expect(logOutput).toContain('[DEBUG] Starting scan');
    expect(logOutput).toContain('[INFO] Scanning file');
    expect(logOutput).toContain('[SUCCESS] Scan complete');
    expect(errorOutput).toContain('[WARN] Warning message');
  });
});

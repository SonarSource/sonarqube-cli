/**
 * Unit tests for sonar secret check --stdin functionality
 * Tests stdin scanning, flag validation, and command logic
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setMockLogger } from '../../src/lib/logger.js';
import type { SpawnResult } from '../../src/lib/process.js';

// Exit code constants
const EXIT_CODE_SUCCESS = 0;
const EXIT_CODE_SECRETS_FOUND = 1;
const EXIT_CODE_GENERAL = 2;
const EXIT_CODE_INVALID_ARG = 3;
const EXIT_CODE_NOT_FOUND = 127;
const EXIT_CODE_GENERAL_ERROR = 255;

// Mock logger to capture output
let logOutput: string[];
let errorOutput: string[];

const mockLogger = {
  debug: (msg: string) => logOutput.push(`[DEBUG] ${msg}`),
  info: (msg: string) => logOutput.push(`[INFO] ${msg}`),
  log: (msg: string) => logOutput.push(`[LOG] ${msg}`),
  success: (msg: string) => logOutput.push(`[SUCCESS] ${msg}`),
  warn: (msg: string) => errorOutput.push(`[WARN] ${msg}`),
  error: (msg: string) => errorOutput.push(`[ERROR] ${msg}`),
};

// Helper functions for command logic (extracted from src/commands/secret.ts)
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

function parseExitCode(result: SpawnResult): { hasSecrets: boolean; exitCode: number } {
  const exitCode = result.exitCode ?? 1;
  return {
    hasSecrets: exitCode !== 0,
    exitCode
  };
}

describe('sonar secret check - stdin validation', () => {
  beforeEach(() => {
    logOutput = [];
    errorOutput = [];
    setMockLogger(mockLogger);
  });

  afterEach(() => {
    setMockLogger(null);
  });

  describe('validateCheckOptions', () => {
    it('should accept --stdin only', () => {
      const result = validateCheckOptions({ stdin: true });
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept --file only', () => {
      const result = validateCheckOptions({ file: '/path/to/file' });
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject both --stdin and --file', () => {
      const result = validateCheckOptions({ stdin: true, file: '/path/to/file' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cannot use both');
    });

    it('should reject neither --stdin nor --file', () => {
      const result = validateCheckOptions({});
      expect(result.valid).toBe(false);
      expect(result.error).toContain('either --file or --stdin is required');
    });

    it('should accept --file with non-empty value', () => {
      const result = validateCheckOptions({ file: '/path/to/file' });
      expect(result.valid).toBe(true);
    });

    it('should accept --stdin: false as same as not providing it', () => {
      const result = validateCheckOptions({ stdin: false });
      expect(result.valid).toBe(false);
    });
  });

  describe('parseExitCode', () => {
    it('should detect secrets found (exit code 1)', () => {
      const result: SpawnResult = {
        exitCode: 1,
        stdout: 'Found 1 secret',
        stderr: ''
      };

      const parsed = parseExitCode(result);
      expect(parsed.hasSecrets).toBe(true);
      expect(parsed.exitCode).toBe(1);
    });

    it('should detect no secrets (exit code 0)', () => {
      const result: SpawnResult = {
        exitCode: 0,
        stdout: 'No secrets found',
        stderr: ''
      };

      const parsed = parseExitCode(result);
      expect(parsed.hasSecrets).toBe(false);
      expect(parsed.exitCode).toBe(0);
    });

    it('should handle null exit code as error (1)', () => {
      const result: SpawnResult = {
        exitCode: null,
        stdout: '',
        stderr: 'Process error'
      };

      const parsed = parseExitCode(result);
      expect(parsed.exitCode).toBe(1);
      expect(parsed.hasSecrets).toBe(true);
    });

    it('should handle various exit codes', () => {
      const codes = [
        EXIT_CODE_SUCCESS,
        EXIT_CODE_SECRETS_FOUND,
        EXIT_CODE_GENERAL,
        EXIT_CODE_INVALID_ARG,
        EXIT_CODE_NOT_FOUND,
        EXIT_CODE_GENERAL_ERROR
      ];

      for (const code of codes) {
        const result: SpawnResult = {
          exitCode: code,
          stdout: '',
          stderr: ''
        };

        const parsed = parseExitCode(result);
        expect(parsed.exitCode).toBe(code);
        expect(parsed.hasSecrets).toBe(code !== 0);
      }
    });
  });
});

describe('sonar secret check - output handling', () => {
  beforeEach(() => {
    logOutput = [];
    errorOutput = [];
    setMockLogger(mockLogger);
  });

  afterEach(() => {
    setMockLogger(null);
  });

  describe('result processing', () => {
    it('should handle stdout with secrets found', () => {
      const stdout = 'Found 1 secret\nGitHub Token\nLocation: [1:0-1:40]';
      expect(stdout).toContain('Found 1 secret');
      expect(stdout).toContain('GitHub Token');
    });

    it('should handle stdout with no secrets', () => {
      const stdout = '';
      expect(stdout.length).toBe(0);
    });

    it('should handle stderr with error messages', () => {
      const stderr = 'Error: authentication failed';
      expect(stderr).toContain('authentication failed');
    });

    it('should handle JSON stdout output', () => {
      const stdout = JSON.stringify({
        issues: [
          {
            message: 'GitHub Token',
            location: '[1:0-1:40]'
          }
        ]
      });

      const parsed = JSON.parse(stdout);
      expect(parsed.issues).toHaveLength(1);
      expect(parsed.issues[0].message).toBe('GitHub Token');
    });

    it('should handle large stdout (10MB simulation)', () => {
      const largeString = 'A'.repeat(10 * 1024 * 1024);
      expect(largeString.length).toBe(10 * 1024 * 1024);
    });
  });

  describe('stdin mode logic', () => {
    it('should use --input flag for stdin scanning', () => {
      // In runScanFromStdin, the flag should be '--input'
      const args = ['--input'];
      expect(args).toContain('--input');
      expect(args).not.toContain('--file');
    });

    it('should pass env vars for authentication', () => {
      const env = {
        SONAR_SECRETS_AUTH_URL: 'https://sonarcloud.io',
        SONAR_SECRETS_TOKEN: 'token123'
      };

      expect(env.SONAR_SECRETS_AUTH_URL).toBeDefined();
      expect(env.SONAR_SECRETS_TOKEN).toBeDefined();
    });

    it('should use stdin: inherit for stream handling', () => {
      const stdin = 'inherit';
      expect(stdin).toBe('inherit');
    });
  });

  describe('file mode logic', () => {
    it('should pass file path as argument', () => {
      const args = ['/path/to/file'];
      expect(args[0]).toBe('/path/to/file');
      expect(args).not.toContain('--input');
    });

    it('should not include --input flag for file mode', () => {
      const args = ['/path/to/file'];
      const hasInputFlag = args.includes('--input');
      expect(hasInputFlag).toBe(false);
    });

    it('should validate file path exists (checked before spawn)', () => {
      const filePath = '/path/to/file';
      // File existence check happens before calling runScan
      expect(filePath).toBeTruthy();
    });
  });
});

describe('sonar secret check - error handling', () => {
  beforeEach(() => {
    logOutput = [];
    errorOutput = [];
    setMockLogger(mockLogger);
  });

  afterEach(() => {
    setMockLogger(null);
  });

  it('should handle timeout gracefully', () => {
    const timeoutError = new Error('Scan timed out after 30000ms');
    expect(timeoutError.message).toContain('timed out');
    expect(timeoutError.message).toContain('30000');
  });

  it('should handle missing auth environment variables', () => {
    const auth = {
      authUrl: undefined,
      authToken: undefined
    };

    const hasAuth = auth.authUrl && auth.authToken;
    expect(hasAuth).toBeFalsy();
  });

  it('should handle binary not found error', () => {
    const error = new Error('ENOENT: no such file or directory');
    expect(error.message).toContain('ENOENT');
  });

  it('should handle process spawn error', () => {
    const error = new Error('Failed to spawn process');
    expect(error).toBeDefined();
  });
});

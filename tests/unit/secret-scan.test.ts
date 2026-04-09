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

/**
 * Tests for secretCheckCommand execution paths:
 * auth failures, successful scans, scan failures, error handling
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../src/ui';
import * as processLib from '../../src/lib/process.js';
import * as stateManager from '../../src/lib/state-manager.js';
import * as installSecrets from '../../src/cli/commands/_common/install/secrets';
import { getDefaultState } from '../../src/lib/state.js';
import { analyzeSecrets } from '../../src/cli/commands/analyze/secrets';
import { CommandFailedError, InvalidOptionError } from '../../src/cli/commands/_common/error.js';
import type { ResolvedAuth } from '../../src/lib/auth-resolver.js';

const SONARCLOUD_URL = 'https://sonarcloud.io';
const TEST_ORG = 'test-org';
const TEST_TOKEN = 'squ_test_token';

const FAKE_AUTH: ResolvedAuth = {
  token: TEST_TOKEN,
  serverUrl: SONARCLOUD_URL,
  orgKey: TEST_ORG,
  connectionType: 'cloud',
};

// Helper: make binary exist, file exist (or not), by controlling existsSync
function mockBinaryExists(fileAlsoExists = true) {
  return spyOn(fs, 'existsSync').mockImplementation((p) => {
    const path = String(p);
    if (path.includes('sonar-secrets')) return true; // binary check
    return fileAlsoExists; // target file check
  });
}

let loadStateSpy: ReturnType<typeof spyOn>;
let saveStateSpy: ReturnType<typeof spyOn>;
let spawnSpy: ReturnType<typeof spyOn>;
let resolveSecretsBinarySpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  setMockUi(true);
  clearMockUiCalls();
  loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
  saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
  spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
    exitCode: 0,
    stdout: '{}',
    stderr: '',
  });
  resolveSecretsBinarySpy = spyOn(installSecrets, 'resolveSecretsBinary').mockResolvedValue({
    binaryPath: '/fake/bin/sonar-secrets',
    freshlyInstalled: false,
  });
});

afterEach(() => {
  loadStateSpy.mockRestore();
  saveStateSpy.mockRestore();
  spawnSpy.mockRestore();
  resolveSecretsBinarySpy.mockRestore();
  setMockUi(false);
});

// ─── Auth forwarding paths ────────────────────────────────────────────────────

describe('secretCheckCommand: auth forwarding', () => {
  it('runs scan when auth is provided', async () => {
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [] }),
      stderr: '',
    });
    const existsSpy = mockBinaryExists();
    try {
      await analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH);
    } finally {
      existsSpy.mockRestore();
    }
  });

  it('passes auth env vars to binary', async () => {
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [] }),
      stderr: '',
    });
    const existsSpy = mockBinaryExists();
    try {
      await analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH);
    } finally {
      existsSpy.mockRestore();
    }

    const spawnCall = spawnSpy.mock.calls[0];
    expect(spawnCall[2].env['SONAR_SECRETS_AUTH_URL']).toBe(SONARCLOUD_URL);
    expect(spawnCall[2].env['SONAR_SECRETS_TOKEN']).toBe(TEST_TOKEN);
  });

  it('passes --non-interactive as first arg to binary for file scan', async () => {
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [] }),
      stderr: '',
    });
    const existsSpy = mockBinaryExists();
    try {
      await analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH);
    } finally {
      existsSpy.mockRestore();
    }

    const spawnCall = spawnSpy.mock.calls[0];
    expect(spawnCall[1][0]).toBe('--non-interactive');
  });

  it('passes all paths as args to binary when given two files', async () => {
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [] }),
      stderr: '',
    });
    const existsSpy = mockBinaryExists(true);
    try {
      await analyzeSecrets({ paths: ['src/index.ts', 'src/lib/auth.ts'] }, FAKE_AUTH);
    } finally {
      existsSpy.mockRestore();
    }

    const spawnCall = spawnSpy.mock.calls[0];
    expect(spawnCall[1]).toEqual(['--non-interactive', 'src/index.ts', 'src/lib/auth.ts']);
  });
});

// ─── Successful scan paths ────────────────────────────────────────────────────

describe('secretCheckCommand: successful scan', () => {
  it('succeeds when scan returns exit code 0 with empty issues list', async () => {
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [] }),
      stderr: '',
    });

    const existsSpy = mockBinaryExists(true);
    try {
      await analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH);
    } finally {
      existsSpy.mockRestore();
    }

    const texts = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(texts.some((m) => m.includes('Issues found: 0'))).toBe(true);
  });

  it('succeeds and displays issue details when scan returns issues with line and severity', async () => {
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        issues: [
          { message: 'Exposed API key', line: 42, severity: 'HIGH' },
          { message: 'Hardcoded password', line: 7, severity: 'CRITICAL' },
        ],
      }),
      stderr: '',
    });

    const existsSpy = mockBinaryExists(true);
    try {
      await analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH);
    } finally {
      existsSpy.mockRestore();
    }

    const errors = getMockUiCalls()
      .filter((c) => c.method === 'error')
      .map((c) => String(c.args[0]));
    expect(errors.some((m) => m.includes('Exposed API key'))).toBe(true);
    expect(errors.some((m) => m.includes('Hardcoded password'))).toBe(true);
    const texts = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(texts.some((m) => m.includes('Line: 42'))).toBe(true);
    expect(texts.some((m) => m.includes('Severity: HIGH'))).toBe(true);
    expect(texts.some((m) => m.includes('Issues found: 2'))).toBe(true);
  });

  it('succeeds and prints raw stdout when scan output is not valid JSON', async () => {
    const rawOutput = 'No issues found (plain text output)';
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: rawOutput,
      stderr: '',
    });

    const existsSpy = mockBinaryExists(true);
    try {
      await analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH);
    } finally {
      existsSpy.mockRestore();
    }

    const prints = getMockUiCalls()
      .filter((c) => c.method === 'print')
      .map((c) => String(c.args[0]));
    expect(prints.some((m) => m.includes(rawOutput))).toBe(true);
  });

  it('succeeds and shows "No issues detected" when JSON has no issues field', async () => {
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ status: 'clean' }),
      stderr: '',
    });

    const existsSpy = mockBinaryExists(true);
    try {
      await analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH);
    } finally {
      existsSpy.mockRestore();
    }

    const texts = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(texts.some((m) => m.includes('No issues detected'))).toBe(true);
  });
});

// ─── Input validation paths ───────────────────────────────────────────────────

describe('secretCheckCommand: input validation', () => {
  it('throws InvalidOptionError when paths array is empty', () => {
    expect(analyzeSecrets({ paths: [] }, FAKE_AUTH)).rejects.toThrow(
      new InvalidOptionError('Either provide file/directory paths or --stdin'),
    );
  });
});

// ─── Failed scan paths ────────────────────────────────────────────────────────

describe('secretCheckCommand: scan failures', () => {
  it('throws when binary exits 51 (secrets found)', async () => {
    spawnSpy.mockResolvedValue({ exitCode: 51, stdout: '', stderr: '' });

    const existsSpy = mockBinaryExists(true);
    try {
      await analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH);
    } catch (e) {
      expect(e).toBeInstanceOf(CommandFailedError);
      expect((e as CommandFailedError).message).toContain('Secrets found');
      expect((e as CommandFailedError).exitCode).toBe(51);
    } finally {
      existsSpy.mockRestore();
    }
  });

  it('throws when binary exits 1 (error, not secrets found)', () => {
    spawnSpy.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'unexpected error' });

    const existsSpy = mockBinaryExists(true);
    try {
      expect(analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH)).rejects.toThrow(
        new CommandFailedError('Scan error (exit code 1)', 1),
      );
    } finally {
      existsSpy.mockRestore();
    }
  });

  it('displays stderr when scan fails with error output', () => {
    const stderrMsg = 'Connection refused to auth server';
    spawnSpy.mockResolvedValue({ exitCode: 2, stdout: '', stderr: stderrMsg });

    const existsSpy = mockBinaryExists(true);
    try {
      expect(analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH)).rejects.toThrow(
        new CommandFailedError('Scan error (exit code 2)', 2),
      );
    } finally {
      existsSpy.mockRestore();
    }

    const prints = getMockUiCalls()
      .filter((c) => c.method === 'print')
      .map((c) => String(c.args[0]));
    expect(prints.some((m) => m.includes(stderrMsg))).toBe(true);
  });

  it('displays stdout when scan fails without stderr', () => {
    const stdoutMsg = '{"error":"auth_failed"}';
    spawnSpy.mockResolvedValue({ exitCode: 2, stdout: stdoutMsg, stderr: '' });

    const existsSpy = mockBinaryExists(true);
    try {
      expect(analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH)).rejects.toThrow(
        new CommandFailedError('Scan error (exit code 2)', 2),
      );
    } finally {
      existsSpy.mockRestore();
    }

    const prints = getMockUiCalls()
      .filter((c) => c.method === 'print')
      .map((c) => String(c.args[0]));
    expect(prints.some((m) => m.includes(stdoutMsg))).toBe(true);
  });
});

// ─── Error handling paths (handleScanError) ───────────────────────────────────

describe('secretCheckCommand: scan error handling', () => {
  it('shows timeout hint and exits 1 when scan times out', async () => {
    spawnSpy.mockRejectedValue(new Error('Scan timed out after 30000ms'));

    const existsSpy = mockBinaryExists(true);
    let caughtError: unknown;
    try {
      await analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH);
    } catch (err) {
      caughtError = err;
    } finally {
      existsSpy.mockRestore();
    }

    expect(caughtError).toBeInstanceOf(CommandFailedError);
    expect((caughtError as CommandFailedError).message).toBe(
      'Error: Scan timed out after 30000ms\n\nThe scan took longer than 30 seconds.\nTry scanning a smaller file or check system resources.\n',
    );
  });

  it('shows reinstall hint and exits 1 when binary is not executable (ENOENT)', async () => {
    spawnSpy.mockRejectedValue(new Error('spawn ENOENT: no such file or directory'));

    const existsSpy = mockBinaryExists(true);
    let caughtError: unknown;
    try {
      await analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH);
    } catch (err) {
      caughtError = err;
    } finally {
      existsSpy.mockRestore();
    }

    expect(caughtError).toBeInstanceOf(CommandFailedError);
    expect((caughtError as CommandFailedError).message).toBe(
      'Error: spawn ENOENT: no such file or directory\n\nThe secrets analyzer binary was not found or is not executable.\nRun: sonar integrate\n',
    );
  });

  it('shows generic status check hint and exits 1 for unexpected errors', async () => {
    spawnSpy.mockRejectedValue(new Error('Something unexpected went wrong'));

    const existsSpy = mockBinaryExists(true);
    let caughtError: unknown;
    try {
      await analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH);
    } catch (err) {
      caughtError = err;
    } finally {
      existsSpy.mockRestore();
    }

    expect(caughtError).toBeInstanceOf(CommandFailedError);
    expect((caughtError as CommandFailedError).message).toBe(
      'Error: Something unexpected went wrong\n\nRun: sonar integrate\n',
    );
  });
});

// ─── stdin scan paths ─────────────────────────────────────────────────────────

async function withMockStdin(content: string, fn: () => Promise<void>): Promise<void> {
  const { EventEmitter } = await import('node:events');
  const mockStdin = new EventEmitter();
  const originalStdin = process.stdin;
  process.stdin = mockStdin as unknown as typeof process.stdin;

  const emitData = (): void => {
    mockStdin.emit('data', Buffer.from(content));
    mockStdin.emit('end');
  };

  // Emit after current microtask so listeners are registered first
  setTimeout(emitData, 0);

  return fn().finally(() => {
    process.stdin = originalStdin;
  });
}

describe('secretCheckCommand: stdin scan', () => {
  it('succeeds when stdin scan succeeds with no issues', async () => {
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [] }),
      stderr: '',
    });

    const existsSpy = mockBinaryExists(true);
    try {
      await withMockStdin('const x = 1;\n', () => analyzeSecrets({ stdin: true }, FAKE_AUTH));
    } finally {
      existsSpy.mockRestore();
    }
  });

  it('throws when binary exits 51 during stdin scan (secrets found)', () => {
    spawnSpy.mockResolvedValue({ exitCode: 51, stdout: '', stderr: 'secret found' });

    const existsSpy = mockBinaryExists(true);
    try {
      expect(
        withMockStdin('const secret = "abc123";\n', () =>
          analyzeSecrets({ stdin: true }, FAKE_AUTH),
        ),
      ).rejects.toThrow(CommandFailedError);
    } finally {
      existsSpy.mockRestore();
    }
  });
});

// ─── CommandFailedError propagation ──────────────────────────────────────────

describe('secretCheckCommand: throws CommandFailedError for scan failures', () => {
  it('rejects with CommandFailedError when binary exits with non-zero code', () => {
    spawnSpy.mockResolvedValue({ exitCode: 51, stdout: '', stderr: '' });

    const existsSpy = mockBinaryExists(true);
    try {
      expect(analyzeSecrets({ paths: ['src/index.ts'] }, FAKE_AUTH)).rejects.toThrow(
        CommandFailedError,
      );
    } finally {
      existsSpy.mockRestore();
    }
  });
});

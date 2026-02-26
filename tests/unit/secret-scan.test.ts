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

/**
 * Tests for secretCheckCommand execution paths:
 * auth failures, successful scans, scan failures, error handling
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui/index.js';
import * as processLib from '../../src/lib/process.js';
import * as stateManager from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';
import { saveToken } from '../../src/lib/keychain.js';
import { secretCheckCommand } from '../../src/commands/secret.js';
import { createMockKeytar } from '../helpers/mock-keytar.js';

const SONARCLOUD_URL = 'https://sonarcloud.io';
const TEST_ORG = 'test-org';
const TEST_TOKEN = 'squ_test_token';

const keytarHandle = createMockKeytar();

// Helper: state with an active connection and a token saved in keychain
async function setupAuthenticatedState(): Promise<void> {
  const state = getDefaultState('test');
  stateManager.addOrUpdateConnection(state, SONARCLOUD_URL, 'cloud', {
    orgKey: TEST_ORG,
    keystoreKey: `sonarcloud.io:${TEST_ORG}`,
  });
  loadStateSpy.mockReturnValue(state);
  await saveToken(SONARCLOUD_URL, TEST_TOKEN, TEST_ORG);
}

// Helper: make binary exist, file exist (or not), by controlling existsSync
function mockBinaryExists(fileAlsoExists = true) {
  return spyOn(fs, 'existsSync').mockImplementation((p) => {
    const path = String(p);
    if (path.includes('sonar-secrets')) return true; // binary check
    return fileAlsoExists; // target file check
  });
}

let mockExit: ReturnType<typeof spyOn>;
let loadStateSpy: ReturnType<typeof spyOn>;
let spawnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  keytarHandle.setup();
  setMockUi(true);
  clearMockUiCalls();
  mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
  spyOn(stateManager, 'saveState').mockImplementation(() => undefined);
  spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
    exitCode: 0,
    stdout: '{}',
    stderr: '',
  });
});

afterEach(() => {
  keytarHandle.teardown();
  mockExit.mockRestore();
  loadStateSpy.mockRestore();
  spawnSpy.mockRestore();
  setMockUi(false);
});

// ─── Auth-optional paths ──────────────────────────────────────────────────────

describe('secretCheckCommand: runs without authentication', () => {
  it('runs scan without auth when no connection is configured', async () => {
    // Default state has no connections — scan should still proceed
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [] }),
      stderr: '',
    });
    const existsSpy = mockBinaryExists();
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(0);
    // Binary should be called without auth env vars (no assertion needed — just no crash)
  });

  it('passes auth env vars to binary when active connection is configured', async () => {
    await setupAuthenticatedState();
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [] }),
      stderr: '',
    });
    const existsSpy = mockBinaryExists();
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(0);
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
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    const spawnCall = spawnSpy.mock.calls[0];
    expect(spawnCall[1][0]).toBe('--non-interactive');
  });
});

// ─── Successful scan paths ────────────────────────────────────────────────────

describe('secretCheckCommand: successful scan', () => {
  it('exits 0 when scan returns exit code 0 with empty issues list', async () => {
    await setupAuthenticatedState();
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [] }),
      stderr: '',
    });

    const existsSpy = mockBinaryExists(true);
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(0);
    const texts = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(texts.some((m) => m.includes('Issues found: 0'))).toBe(true);
  });

  it('exits 0 and displays issue details when scan returns issues with line and severity', async () => {
    await setupAuthenticatedState();
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
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(0);
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

  it('exits 0 and prints raw stdout when scan output is not valid JSON', async () => {
    await setupAuthenticatedState();
    const rawOutput = 'No issues found (plain text output)';
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: rawOutput,
      stderr: '',
    });

    const existsSpy = mockBinaryExists(true);
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(0);
    const prints = getMockUiCalls()
      .filter((c) => c.method === 'print')
      .map((c) => String(c.args[0]));
    expect(prints.some((m) => m.includes(rawOutput))).toBe(true);
  });

  it('exits 0 and shows "No issues detected" when JSON has no issues field', async () => {
    await setupAuthenticatedState();
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ status: 'clean' }),
      stderr: '',
    });

    const existsSpy = mockBinaryExists(true);
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(0);
    const texts = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(texts.some((m) => m.includes('No issues detected'))).toBe(true);
  });
});

// ─── Failed scan paths ────────────────────────────────────────────────────────

describe('secretCheckCommand: scan failures', () => {
  it('exits 51 when binary exits 51 (secrets found)', async () => {
    await setupAuthenticatedState();
    spawnSpy.mockResolvedValue({ exitCode: 51, stdout: '', stderr: '' });

    const existsSpy = mockBinaryExists(true);
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(51);
    const errors = getMockUiCalls()
      .filter((c) => c.method === 'error')
      .map((c) => String(c.args[0]));
    expect(errors.some((m) => m.includes('Scan found secrets'))).toBe(true);
  });

  it('exits 1 when binary exits 1 (error, not secrets found)', async () => {
    await setupAuthenticatedState();
    spawnSpy.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'unexpected error' });

    const existsSpy = mockBinaryExists(true);
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('displays stderr when scan fails with error output', async () => {
    await setupAuthenticatedState();
    const stderrMsg = 'Connection refused to auth server';
    spawnSpy.mockResolvedValue({ exitCode: 2, stdout: '', stderr: stderrMsg });

    const existsSpy = mockBinaryExists(true);
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(2);
    const prints = getMockUiCalls()
      .filter((c) => c.method === 'print')
      .map((c) => String(c.args[0]));
    expect(prints.some((m) => m.includes(stderrMsg))).toBe(true);
  });

  it('displays stdout when scan fails without stderr', async () => {
    await setupAuthenticatedState();
    const stdoutMsg = '{"error":"auth_failed"}';
    spawnSpy.mockResolvedValue({ exitCode: 2, stdout: stdoutMsg, stderr: '' });

    const existsSpy = mockBinaryExists(true);
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(2);
    const prints = getMockUiCalls()
      .filter((c) => c.method === 'print')
      .map((c) => String(c.args[0]));
    expect(prints.some((m) => m.includes(stdoutMsg))).toBe(true);
  });
});

// ─── Error handling paths (handleScanError) ───────────────────────────────────

describe('secretCheckCommand: scan error handling', () => {
  it('shows timeout hint and exits 1 when scan times out', async () => {
    await setupAuthenticatedState();
    spawnSpy.mockRejectedValue(new Error('Scan timed out after 30000ms'));

    const existsSpy = mockBinaryExists(true);
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const texts = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(texts.some((m) => m.includes('30 seconds'))).toBe(true);
  });

  it('shows reinstall hint and exits 1 when binary is not executable (ENOENT)', async () => {
    await setupAuthenticatedState();
    spawnSpy.mockRejectedValue(new Error('spawn ENOENT: no such file or directory'));

    const existsSpy = mockBinaryExists(true);
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const texts = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(texts.some((m) => m.includes('sonar install secrets --force'))).toBe(true);
  });

  it('shows generic status check hint and exits 1 for unexpected errors', async () => {
    await setupAuthenticatedState();
    spawnSpy.mockRejectedValue(new Error('Something unexpected went wrong'));

    const existsSpy = mockBinaryExists(true);
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const texts = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(texts.some((m) => m.includes('sonar install secrets --status'))).toBe(true);
  });
});

// ─── stdin scan paths ─────────────────────────────────────────────────────────

describe('secretCheckCommand: stdin scan', () => {
  function withMockStdin(content: string, fn: () => Promise<void>): Promise<void> {
    const { EventEmitter } = require('node:events');
    const mockStdin = new EventEmitter();
    const originalStdin = process.stdin;
    // @ts-ignore — replace stdin for test
    process.stdin = mockStdin;

    const emitData = (): void => {
      mockStdin.emit('data', Buffer.from(content));
      mockStdin.emit('end');
    };

    // Emit after current microtask so listeners are registered first
    setTimeout(emitData, 0);

    return fn().finally(() => {
      // @ts-ignore
      process.stdin = originalStdin;
    });
  }

  it('exits 0 when stdin scan succeeds with no issues', async () => {
    await setupAuthenticatedState();
    spawnSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [] }),
      stderr: '',
    });

    const existsSpy = mockBinaryExists(true);
    try {
      await withMockStdin('const x = 1;\n', () => secretCheckCommand({ stdin: true }));
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('exits 51 when binary exits 51 during stdin scan (secrets found)', async () => {
    await setupAuthenticatedState();
    spawnSpy.mockResolvedValue({ exitCode: 51, stdout: '', stderr: 'secret found' });

    const existsSpy = mockBinaryExists(true);
    try {
      await withMockStdin('const secret = "abc123";\n', () => secretCheckCommand({ stdin: true }));
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(51);
  });
});

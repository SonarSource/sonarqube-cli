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
    if (path.includes('sonar-secrets')) return true;  // binary check
    return fileAlsoExists;                              // target file check
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
  spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({ exitCode: 0, stdout: '{}', stderr: '' });
});

afterEach(() => {
  keytarHandle.teardown();
  mockExit.mockRestore();
  loadStateSpy.mockRestore();
  spawnSpy.mockRestore();
  setMockUi(false);
});

// ─── Auth failure paths ───────────────────────────────────────────────────────

describe('secretCheckCommand: auth failures', () => {
  it('exits 1 and shows config instructions when no active connection exists', async () => {
    // Default state has no connections
    const existsSpy = mockBinaryExists();
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('authentication is not configured'))).toBe(true);
    const texts = getMockUiCalls().filter(c => c.method === 'text').map(c => String(c.args[0]));
    expect(texts.some(m => m.includes('SONAR_SECRETS_AUTH_URL'))).toBe(true);
  });

  it('exits 1 when connection exists but no token is stored in keychain', async () => {
    // Active connection but keychain has no token for it
    const state = getDefaultState('test');
    stateManager.addOrUpdateConnection(state, SONARCLOUD_URL, 'cloud', {
      orgKey: TEST_ORG,
      keystoreKey: `sonarcloud.io:${TEST_ORG}`,
    });
    loadStateSpy.mockReturnValue(state);
    // No saveToken call → keychain returns null

    const existsSpy = mockBinaryExists();
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('authentication is not configured'))).toBe(true);
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
    const texts = getMockUiCalls().filter(c => c.method === 'text').map(c => String(c.args[0]));
    expect(texts.some(m => m.includes('Issues found: 0'))).toBe(true);
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
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('Exposed API key'))).toBe(true);
    expect(errors.some(m => m.includes('Hardcoded password'))).toBe(true);
    const texts = getMockUiCalls().filter(c => c.method === 'text').map(c => String(c.args[0]));
    expect(texts.some(m => m.includes('Line: 42'))).toBe(true);
    expect(texts.some(m => m.includes('Severity: HIGH'))).toBe(true);
    expect(texts.some(m => m.includes('Issues found: 2'))).toBe(true);
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
    const prints = getMockUiCalls().filter(c => c.method === 'print').map(c => String(c.args[0]));
    expect(prints.some(m => m.includes(rawOutput))).toBe(true);
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
    const texts = getMockUiCalls().filter(c => c.method === 'text').map(c => String(c.args[0]));
    expect(texts.some(m => m.includes('No issues detected'))).toBe(true);
  });
});

// ─── Failed scan paths ────────────────────────────────────────────────────────

describe('secretCheckCommand: scan failures', () => {
  it('exits with scan exit code when scan fails', async () => {
    await setupAuthenticatedState();
    spawnSpy.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

    const existsSpy = mockBinaryExists(true);
    try {
      await secretCheckCommand({ file: 'src/index.ts' });
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('Scan failed'))).toBe(true);
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
    const prints = getMockUiCalls().filter(c => c.method === 'print').map(c => String(c.args[0]));
    expect(prints.some(m => m.includes(stderrMsg))).toBe(true);
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
    const prints = getMockUiCalls().filter(c => c.method === 'print').map(c => String(c.args[0]));
    expect(prints.some(m => m.includes(stdoutMsg))).toBe(true);
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
    const texts = getMockUiCalls().filter(c => c.method === 'text').map(c => String(c.args[0]));
    expect(texts.some(m => m.includes('30 seconds'))).toBe(true);
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
    const texts = getMockUiCalls().filter(c => c.method === 'text').map(c => String(c.args[0]));
    expect(texts.some(m => m.includes('sonar secret install --force'))).toBe(true);
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
    const texts = getMockUiCalls().filter(c => c.method === 'text').map(c => String(c.args[0]));
    expect(texts.some(m => m.includes('sonar secret status'))).toBe(true);
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
      await withMockStdin('const x = 1;\n', () =>
        secretCheckCommand({ stdin: true })
      );
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('exits with scan exit code when stdin scan fails', async () => {
    await setupAuthenticatedState();
    spawnSpy.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'secret found' });

    const existsSpy = mockBinaryExists(true);
    try {
      await withMockStdin('const secret = "abc123";\n', () =>
        secretCheckCommand({ stdin: true })
      );
    } finally {
      existsSpy.mockRestore();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

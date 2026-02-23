// Unit tests for sonar verify command

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyCommand } from '../../src/commands/verify.js';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import * as stateManager from '../../src/lib/state-manager.js';
import { getDefaultState } from '../../src/lib/state.js';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui';
import { createMockKeytar } from '../helpers/mock-keytar.js';

const keytarHandle = createMockKeytar();

describe('verifyCommand', () => {
  let mockExit: ReturnType<typeof spyOn>;

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    keytarHandle.teardown();
    mockExit.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when required params are missing', async () => {
    await verifyCommand({ file: '' });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 0 when analysis succeeds', async () => {
    const testDir = join(tmpdir(), `test-verify-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const testFile = join(testDir, 'test.ts');
    writeFileSync(testFile, 'const x = 1;\n');

    const loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    const postSpy = spyOn(SonarQubeClient.prototype, 'post').mockResolvedValue({ issues: [] });

    try {
      await verifyCommand({
        file: testFile,
        token: 'test-token',
        organizationKey: 'test-org',
        projectKey: 'test-project',
      });
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      loadStateSpy.mockRestore();
      postSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ─── on-premise check ─────────────────────────────────────────────────────────

describe('verifyCommand: on-premise server', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    clearMockUiCalls();
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const state = getDefaultState('test');
    stateManager.addOrUpdateConnection(state, 'https://sonarqube.company.com', 'on-premise', {
      keystoreKey: 'sonarqube.company.com',
    });
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(state);
  });

  afterEach(() => {
    keytarHandle.teardown();
    loadStateSpy.mockRestore();
    mockExit.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when active connection is on-premise', async () => {
    await verifyCommand({ file: 'any.ts' });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('shows error mentioning on-premise limitation', async () => {
    await verifyCommand({ file: 'any.ts' });
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('on-premise'))).toBe(true);
  });
});

// ─── formatResults + handleAnalysisError ─────────────────────────────────────

describe('verifyCommand: formatResults and error handling', () => {
  let testDir: string;
  let testFile: string;
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let postSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    clearMockUiCalls();
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    testDir = join(tmpdir(), `test-verify-fmt-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    testFile = join(testDir, 'test.ts');
    writeFileSync(testFile, 'const x = 1;\n');
  });

  afterEach(() => {
    keytarHandle.teardown();
    loadStateSpy.mockRestore();
    postSpy?.mockRestore();
    mockExit.mockRestore();
    setMockUi(false);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('outputs JSON format when result has 3 issues (below threshold)', async () => {
    postSpy = spyOn(SonarQubeClient.prototype, 'post').mockResolvedValue({
      issues: [
        { ruleKey: 'r1', message: 'issue 1', severity: 'HIGH' },
        { ruleKey: 'r2', message: 'issue 2', severity: 'MEDIUM' },
        { ruleKey: 'r3', message: 'issue 3', severity: 'LOW' },
      ],
    });
    await verifyCommand({ file: testFile, token: 'tok', organizationKey: 'org', projectKey: 'proj' });
    expect(mockExit).toHaveBeenCalledWith(0);
    const prints = getMockUiCalls().filter(c => c.method === 'print').map(c => String(c.args[0]));
    expect(prints.some(m => m.includes('"issues"'))).toBe(true);
  });

  it('outputs non-JSON TOON format when result has 6 issues (above threshold)', async () => {
    postSpy = spyOn(SonarQubeClient.prototype, 'post').mockResolvedValue({
      issues: Array.from({ length: 6 }, (_, i) => ({
        ruleKey: `rule-${i}`,
        message: `issue ${i}`,
        severity: 'HIGH',
      })),
    });
    await verifyCommand({ file: testFile, token: 'tok', organizationKey: 'org', projectKey: 'proj' });
    expect(mockExit).toHaveBeenCalledWith(0);
    const prints = getMockUiCalls().filter(c => c.method === 'print').map(c => String(c.args[0]));
    // TOON format — output is present but not JSON
    expect(prints.length).toBeGreaterThan(0);
    expect(prints.some(m => {
      try { JSON.parse(m); return true; } catch { return false; }
    })).toBe(false);
  });

  it('exits 1 and shows troubleshooting when analysis API fails', async () => {
    postSpy = spyOn(SonarQubeClient.prototype, 'post').mockRejectedValue(new Error('403 Unauthorized'));
    await verifyCommand({ file: testFile, token: 'tok', organizationKey: 'test-org', projectKey: 'proj' });
    expect(mockExit).toHaveBeenCalledWith(1);
    const errors = getMockUiCalls().filter(c => c.method === 'error').map(c => String(c.args[0]));
    expect(errors.some(m => m.includes('Troubleshooting'))).toBe(true);
    expect(errors.some(m => m.includes('test-org'))).toBe(true);
  });
});

// ─── validateConfiguration paths ─────────────────────────────────────────────

describe('verifyCommand: validation errors', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    clearMockUiCalls();
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
  });

  afterEach(() => {
    keytarHandle.teardown();
    loadStateSpy.mockRestore();
    mockExit.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when file is empty string but token provided', async () => {
    await verifyCommand({ file: '', token: 'tok', organizationKey: 'org', projectKey: 'proj' });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when organization key is missing', async () => {
    const testDir = join(tmpdir(), `test-verify-noorg-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const testFile = join(testDir, 'test.ts');
    writeFileSync(testFile, 'const x = 1;\n');

    try {
      await verifyCommand({ file: testFile, token: 'tok', projectKey: 'proj' });
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when project key is missing', async () => {
    const testDir = join(tmpdir(), `test-verify-noproj-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const testFile = join(testDir, 'test.ts');
    writeFileSync(testFile, 'const x = 1;\n');
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    try {
      await verifyCommand({ file: testFile, token: 'tok', organizationKey: 'org' });
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when file path does not exist', async () => {
    await verifyCommand({
      file: '/nonexistent/path/to/file.ts',
      token: 'tok',
      organizationKey: 'org',
      projectKey: 'proj',
    });
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

// ─── branch option + non-SonarCloud server ────────────────────────────────────

describe('verifyCommand: branch and server variations', () => {
  let testDir: string;
  let testFile: string;
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let postSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    clearMockUiCalls();
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    testDir = join(tmpdir(), `test-verify-branch-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    testFile = join(testDir, 'test.ts');
    writeFileSync(testFile, 'const x = 1;\n');
    postSpy = spyOn(SonarQubeClient.prototype, 'post').mockResolvedValue({ issues: [] });
  });

  afterEach(() => {
    keytarHandle.teardown();
    loadStateSpy.mockRestore();
    postSpy.mockRestore();
    mockExit.mockRestore();
    setMockUi(false);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('includes branch in request when branch option is provided', async () => {
    await verifyCommand({
      file: testFile,
      token: 'tok',
      organizationKey: 'org',
      projectKey: 'proj',
      branch: 'feature/my-branch',
    });
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(postSpy).toHaveBeenCalled();
    const callArgs = postSpy.mock.calls[0];
    expect(JSON.stringify(callArgs)).toContain('feature/my-branch');
  });

  it('exits 0 and uses server URL as-is when server is not SonarCloud', async () => {
    const savedToken = process.env['SONAR_CLI_TOKEN'];
    const savedServer = process.env['SONAR_CLI_SERVER'];
    process.env['SONAR_CLI_TOKEN'] = 'env-token';
    process.env['SONAR_CLI_SERVER'] = 'https://sonarqube.example.com';

    try {
      await verifyCommand({
        file: testFile,
        organizationKey: 'org',
        projectKey: 'proj',
      });
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      if (savedToken === undefined) delete process.env['SONAR_CLI_TOKEN'];
      else process.env['SONAR_CLI_TOKEN'] = savedToken;
      if (savedServer === undefined) delete process.env['SONAR_CLI_SERVER'];
      else process.env['SONAR_CLI_SERVER'] = savedServer;
    }
  });
});

// ─── checkServerType: loadState throws ────────────────────────────────────────

describe('verifyCommand: checkServerType loadState failure', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let postSpy: ReturnType<typeof spyOn>;
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    keytarHandle.setup();
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    testDir = join(tmpdir(), `test-verify-statethrows-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    testFile = join(testDir, 'test.ts');
    writeFileSync(testFile, 'const x = 1;\n');
  });

  afterEach(() => {
    keytarHandle.teardown();
    loadStateSpy?.mockRestore();
    postSpy?.mockRestore();
    mockExit.mockRestore();
    setMockUi(false);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('proceeds normally when loadState throws inside checkServerType', async () => {
    let callCount = 0;
    loadStateSpy = spyOn(stateManager, 'loadState').mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('state file corrupted');
      return getDefaultState('test');
    });
    postSpy = spyOn(SonarQubeClient.prototype, 'post').mockResolvedValue({ issues: [] });

    await verifyCommand({
      file: testFile,
      token: 'tok',
      organizationKey: 'org',
      projectKey: 'proj',
    });
    expect(mockExit).toHaveBeenCalledWith(0);
  });
});

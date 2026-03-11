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

// Unit tests for analyzeA3s and analyzeFile (full pipeline) commands

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../src/ui';
import * as stateManager from '../../src/lib/state-manager.js';
import * as authResolver from '../../src/lib/auth-resolver.js';
import * as processLib from '../../src/lib/process.js';
import { SonarQubeClient } from '../../src/sonarqube/client.js';
import { getDefaultState } from '../../src/lib/state.js';
import { analyzeA3s, analyzeFile } from '../../src/cli/commands/analyze/secrets';
import { CommandFailedError, InvalidOptionError } from '../../src/cli/commands/_common/error.js';

const SONARCLOUD_URL = 'https://sonarcloud.io';
const TEST_ORG = 'test-org';
const TEST_PROJECT = 'my-project';
const TEST_TOKEN = 'squ_test_token';
const FILE_CONTENT = 'const x = 1;\n';

/** Fake auth for a cloud connection */
const FAKE_AUTH: import('../../src/lib/auth-resolver.js').ResolvedAuth = {
  token: TEST_TOKEN,
  serverUrl: SONARCLOUD_URL,
  orgKey: TEST_ORG,
  connectionType: 'cloud',
};

let loadStateSpy: ReturnType<typeof spyOn>;
let resolveAuthSpy: ReturnType<typeof spyOn>;
let existsSpy: ReturnType<typeof spyOn>;
let readFileSpy: ReturnType<typeof spyOn>;
let analyzeFileSpy: ReturnType<typeof spyOn>;

/** Cloud state WITH a sonar-a3s extension entry for the current project root */
function makeCloudState() {
  const state = getDefaultState('test');
  stateManager.addOrUpdateConnection(state, SONARCLOUD_URL, 'cloud', {
    orgKey: TEST_ORG,
    keystoreKey: `sonarcloud.io:${TEST_ORG}`,
  });
  stateManager.upsertAgentExtension(state, {
    id: 'test-ext',
    agentId: 'claude-code',
    projectRoot: process.cwd(),
    global: false,
    projectKey: TEST_PROJECT,
    orgKey: TEST_ORG,
    serverUrl: SONARCLOUD_URL,
    updatedByCliVersion: '1.0.0',
    updatedAt: new Date().toISOString(),
    kind: 'hook',
    name: 'sonar-a3s',
    hookType: 'PostToolUse',
  });
  return state;
}

/** Cloud state WITHOUT any extensions (simulates missing registry entry) */
function makeCloudStateNoExt() {
  const state = getDefaultState('test');
  stateManager.addOrUpdateConnection(state, SONARCLOUD_URL, 'cloud', {
    orgKey: TEST_ORG,
    keystoreKey: `sonarcloud.io:${TEST_ORG}`,
  });
  return state;
}

beforeEach(() => {
  setMockUi(true);
  clearMockUiCalls();

  loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(makeCloudState());
  spyOn(stateManager, 'saveState').mockImplementation(() => undefined);

  resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue(FAKE_AUTH);

  existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
  readFileSpy = spyOn(fs, 'readFileSync').mockReturnValue(FILE_CONTENT);

  analyzeFileSpy = spyOn(SonarQubeClient.prototype, 'analyzeFile').mockResolvedValue({
    id: 'analysis-1',
    issues: [],
    errors: null,
  });
});

afterEach(() => {
  setMockUi(false);
  loadStateSpy.mockRestore();
  resolveAuthSpy.mockRestore();
  existsSpy.mockRestore();
  readFileSpy.mockRestore();
  analyzeFileSpy.mockRestore();
});

// ─── analyzeA3s ──────────────────────────────────────────────────────────────

describe('analyzeA3s: input validation', () => {
  it('throws InvalidOptionError when file does not exist', () => {
    existsSpy.mockReturnValue(false);

    expect(analyzeA3s({ file: 'nonexistent.ts' })).rejects.toThrow(InvalidOptionError);
    expect(analyzeA3s({ file: 'nonexistent.ts' })).rejects.toThrow('File not found');
  });
});

describe('analyzeA3s: auth resolution', () => {
  it('skips A3S when resolveAuth throws (no auth configured)', async () => {
    resolveAuthSpy.mockRejectedValue(new Error('No token'));

    await analyzeA3s({ file: 'src/index.ts' });
    expect(analyzeFileSpy).not.toHaveBeenCalled();
  });

  it('skips A3S when token is missing from resolved auth', async () => {
    resolveAuthSpy.mockResolvedValue({ token: '', serverUrl: SONARCLOUD_URL, orgKey: TEST_ORG });

    await analyzeA3s({ file: 'src/index.ts' });
    expect(analyzeFileSpy).not.toHaveBeenCalled();
  });

  it('skips A3S when orgKey is missing from resolved auth', async () => {
    resolveAuthSpy.mockResolvedValue({ token: TEST_TOKEN, serverUrl: SONARCLOUD_URL });

    await analyzeA3s({ file: 'src/index.ts' });
    expect(analyzeFileSpy).not.toHaveBeenCalled();
  });

  it('skips A3S for on-premise server connection', async () => {
    resolveAuthSpy.mockResolvedValue({
      token: TEST_TOKEN,
      serverUrl: 'https://mysonar.company.com',
      orgKey: TEST_ORG,
      connectionType: 'on-premise',
    });

    await analyzeA3s({ file: 'src/index.ts' });
    expect(analyzeFileSpy).not.toHaveBeenCalled();
  });

  it('skips A3S when no extension found in registry for this project', async () => {
    loadStateSpy.mockReturnValue(makeCloudStateNoExt());

    await analyzeA3s({ file: 'src/index.ts' });
    expect(analyzeFileSpy).not.toHaveBeenCalled();
  });

  it('skips A3S when extension has no projectKey', async () => {
    const state = getDefaultState('test');
    stateManager.addOrUpdateConnection(state, SONARCLOUD_URL, 'cloud', {
      orgKey: TEST_ORG,
      keystoreKey: `sonarcloud.io:${TEST_ORG}`,
    });
    // Extension exists but projectKey is undefined
    stateManager.upsertAgentExtension(state, {
      id: 'ext-no-key',
      agentId: 'claude-code',
      projectRoot: process.cwd(),
      global: false,
      orgKey: TEST_ORG,
      serverUrl: SONARCLOUD_URL,
      updatedByCliVersion: '1.0.0',
      updatedAt: new Date().toISOString(),
      kind: 'hook',
      name: 'sonar-a3s',
      hookType: 'PostToolUse',
    });
    loadStateSpy.mockReturnValue(state);

    await analyzeA3s({ file: 'src/index.ts' });
    expect(analyzeFileSpy).not.toHaveBeenCalled();
  });
});

describe('analyzeA3s: API call and result display', () => {
  it('calls client.analyzeFile with correct parameters', async () => {
    await analyzeA3s({ file: 'src/index.ts' });

    expect(analyzeFileSpy).toHaveBeenCalledTimes(1);
    const request = analyzeFileSpy.mock.calls[0][0];
    expect(request.organizationKey).toBe(TEST_ORG);
    expect(request.projectKey).toBe(TEST_PROJECT);
    expect(request.fileContent).toBe(FILE_CONTENT);
    expect(typeof request.filePath).toBe('string');
  });

  it('does not send branchName in request when no branch is provided', async () => {
    await analyzeA3s({ file: 'src/index.ts' });

    const request = analyzeFileSpy.mock.calls[0][0];
    // branchName: null causes a 400 from the real API — must be omitted entirely
    expect(request.branchName).toBeUndefined();
  });

  it('passes branch to client when --branch option is provided', async () => {
    await analyzeA3s({ file: 'src/index.ts', branch: 'feature/my-branch' });

    const request = analyzeFileSpy.mock.calls[0][0];
    expect(request.branchName).toBe('feature/my-branch');
  });

  it('displays success message when no issues found', async () => {
    analyzeFileSpy.mockResolvedValue({ id: 'a1', issues: [], errors: null });

    await analyzeA3s({ file: 'src/index.ts' });

    const output = getMockUiCalls().map((c) => String(c.args[0]));
    expect(output.some((m) => m.toLowerCase().includes('no issues found'))).toBe(true);
  });

  it('displays issue count and details when issues are found', async () => {
    analyzeFileSpy.mockResolvedValue({
      id: 'a1',
      issues: [
        {
          rule: 'python:S1234',
          message: 'Refactor this method',
          textRange: { startLine: 5, endLine: 5, startOffset: 0, endOffset: 10 },
        },
        {
          rule: 'python:S5678',
          message: 'Remove unused variable',
          textRange: null,
        },
      ],
      errors: null,
    });

    await analyzeA3s({ file: 'main.py' });

    const output = getMockUiCalls()
      .map((c) => String(c.args[0]))
      .join('\n');
    expect(output).toContain('2 issue');
    expect(output).toContain('Refactor this method');
    expect(output).toContain('line 5');
    expect(output).toContain('python:S1234');
    expect(output).toContain('Remove unused variable');
  });

  it('displays API error codes when response contains errors', async () => {
    analyzeFileSpy.mockResolvedValue({
      id: 'a1',
      issues: [],
      errors: [{ code: 'NOT_ENTITLED', message: 'Organization not entitled to A3S' }],
    });

    await analyzeA3s({ file: 'src/index.ts' });

    const output = getMockUiCalls()
      .map((c) => String(c.args[0]))
      .join('\n');
    expect(output).toContain('NOT_ENTITLED');
    expect(output).toContain('not entitled');
  });

  it('throws CommandFailedError when A3S API call fails', () => {
    analyzeFileSpy.mockRejectedValue(new Error('Network error'));

    expect(analyzeA3s({ file: 'src/index.ts' })).rejects.toThrow('A3S analysis failed');
  });
});

// ─── analyzeA3s: explicit --project option ───────────────────────────────────

describe('analyzeA3s: explicit --project option', () => {
  it('uses provided project key directly without consulting extensions registry', async () => {
    loadStateSpy.mockReturnValue(makeCloudStateNoExt());

    await analyzeA3s({ file: 'src/index.ts', project: 'explicit-project' });

    expect(analyzeFileSpy).toHaveBeenCalledTimes(1);
    expect(analyzeFileSpy.mock.calls[0][0].projectKey).toBe('explicit-project');
  });

  it('uses provided project key even when extension has a different project key', async () => {
    await analyzeA3s({ file: 'src/index.ts', project: 'override-project' });

    expect(analyzeFileSpy).toHaveBeenCalledTimes(1);
    expect(analyzeFileSpy.mock.calls[0][0].projectKey).toBe('override-project');
  });

  it('throws CommandFailedError with auth hint when --project given but no auth', () => {
    resolveAuthSpy.mockResolvedValue({ token: '', serverUrl: SONARCLOUD_URL, orgKey: TEST_ORG });

    expect(analyzeA3s({ file: 'src/index.ts', project: 'my-project' })).rejects.toThrow(
      CommandFailedError,
    );
  });

  it('throws CommandFailedError when --project given but on-premise server', () => {
    resolveAuthSpy.mockResolvedValue({
      token: TEST_TOKEN,
      serverUrl: 'https://mysonar.company.com',
      orgKey: TEST_ORG,
      connectionType: 'on-premise',
    });

    expect(analyzeA3s({ file: 'src/index.ts', project: 'my-project' })).rejects.toThrow(
      CommandFailedError,
    );
  });
});

// ─── analyzeFile (full pipeline) ─────────────────────────────────────────────

describe('analyzeFile: input validation', () => {
  it('throws InvalidOptionError with "--file is required" when no file is given', () => {
    // Simulates CLI calling analyzeFile without --file (manual arg parsing yields undefined)
    expect(analyzeFile({ file: undefined as unknown as string })).rejects.toThrow(
      '--file is required',
    );
  });

  it('throws InvalidOptionError when file does not exist', () => {
    existsSpy.mockReturnValue(false);

    expect(analyzeFile({ file: 'nonexistent.ts' })).rejects.toThrow(InvalidOptionError);
  });

  it('throws CommandFailedError when file cannot be read', () => {
    readFileSpy.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    expect(analyzeFile({ file: 'src/index.ts' })).rejects.toThrow('Failed to read file');
  });
});

describe('analyzeFile: secrets scan gate', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: '{}',
      stderr: '',
    });
    // Make binary appear installed
    existsSpy.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.includes('sonar-secrets')) return true;
      return true; // target file exists too
    });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('warns and returns early without calling A3S when secrets are detected', async () => {
    spawnSpy.mockResolvedValue({ exitCode: 51, stdout: '', stderr: '' });

    await analyzeFile({ file: 'src/index.ts' });

    const output = getMockUiCalls()
      .map((c) => String(c.args[0]))
      .join('\n');
    expect(output.toLowerCase()).toContain('secrets detected');
    expect(analyzeFileSpy).not.toHaveBeenCalled();
  });

  it('proceeds to A3S when secrets scan passes (exit 0)', async () => {
    spawnSpy.mockResolvedValue({ exitCode: 0, stdout: '{}', stderr: '' });

    await analyzeFile({ file: 'src/index.ts' });

    expect(analyzeFileSpy).toHaveBeenCalledTimes(1);
  });

  it('proceeds to A3S when secrets scan errors (non-blocking)', async () => {
    spawnSpy.mockRejectedValue(new Error('binary crashed'));

    await analyzeFile({ file: 'src/index.ts' });

    // Secrets scan error is non-blocking — A3S should still run
    expect(analyzeFileSpy).toHaveBeenCalledTimes(1);
  });
});

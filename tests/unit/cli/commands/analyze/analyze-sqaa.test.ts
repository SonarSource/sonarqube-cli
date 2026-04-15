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

// Unit tests for analyzeSqaa command

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../src/ui';
import * as stateManager from '../../../../../src/lib/state-manager.js';
import { SonarQubeClient } from '../../../../../src/sonarqube/client.js';
import { getDefaultState } from '../../../../../src/lib/state.js';
import { analyzeSqaa } from '../../../../../src/cli/commands/analyze/sqaa';
import {
  CommandFailedError,
  InvalidOptionError,
} from '../../../../../src/cli/commands/_common/error.js';

const SONARCLOUD_URL = 'https://sonarcloud.io';
const TEST_ORG = 'test-org';
const TEST_PROJECT = 'my-project';
const TEST_TOKEN = 'squ_test_token';
const FILE_CONTENT = 'const x = 1;\n';

/** Fake auth for a cloud connection */
const FAKE_AUTH: import('../../../../../src/lib/auth-resolver.js').ResolvedAuth = {
  token: TEST_TOKEN,
  serverUrl: SONARCLOUD_URL,
  orgKey: TEST_ORG,
  connectionType: 'cloud',
};

let loadStateSpy: ReturnType<typeof spyOn>;
let saveStateSpy: ReturnType<typeof spyOn>;
let existsSpy: ReturnType<typeof spyOn>;
let readFileSpy: ReturnType<typeof spyOn>;
let analyzeFileSpy: ReturnType<typeof spyOn>;

/** Cloud state WITH a sonar-sqaa extension entry for the current project root */
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
    name: 'sonar-sqaa',
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
  saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => undefined);

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
  saveStateSpy.mockRestore();
  existsSpy.mockRestore();
  readFileSpy.mockRestore();
  analyzeFileSpy.mockRestore();
});

// ─── analyzeSqaa ─────────────────────────────────────────────────────────────

describe('analyzeSqaa: input validation', () => {
  it('throws InvalidOptionError when file does not exist', () => {
    existsSpy.mockReturnValue(false);

    expect(analyzeSqaa({ file: 'nonexistent.ts' }, FAKE_AUTH)).rejects.toThrow(InvalidOptionError);
    expect(analyzeSqaa({ file: 'nonexistent.ts' }, FAKE_AUTH)).rejects.toThrow('File not found');
  });
});

describe('analyzeSqaa: auth resolution', () => {
  it('skips SQAA when orgKey is missing from auth', async () => {
    const noOrgAuth = { ...FAKE_AUTH, orgKey: undefined };

    await analyzeSqaa({ file: 'src/index.ts' }, noOrgAuth as typeof FAKE_AUTH);
    expect(analyzeFileSpy).not.toHaveBeenCalled();
  });

  it('skips SQAA for on-premise server connection', async () => {
    const onPremiseAuth = {
      token: TEST_TOKEN,
      serverUrl: 'https://mysonar.company.com',
      orgKey: TEST_ORG,
      connectionType: 'on-premise' as const,
    };

    await analyzeSqaa({ file: 'src/index.ts' }, onPremiseAuth);
    expect(analyzeFileSpy).not.toHaveBeenCalled();
  });

  it('skips SQAA when no extension found in registry for this project', async () => {
    loadStateSpy.mockReturnValue(makeCloudStateNoExt());

    await analyzeSqaa({ file: 'src/index.ts' }, FAKE_AUTH);

    expect(analyzeFileSpy).not.toHaveBeenCalled();
  });

  it('skips SQAA when extension has no projectKey', async () => {
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
      name: 'sonar-sqaa',
      hookType: 'PostToolUse',
    });
    loadStateSpy.mockReturnValue(state);

    await analyzeSqaa({ file: 'src/index.ts' }, FAKE_AUTH);
    expect(analyzeFileSpy).not.toHaveBeenCalled();
  });
});

describe('analyzeSqaa: API call and result display', () => {
  it('calls client.analyzeFile with correct parameters', async () => {
    await analyzeSqaa({ file: 'src/index.ts' }, FAKE_AUTH);

    expect(analyzeFileSpy).toHaveBeenCalledTimes(1);
    const request = analyzeFileSpy.mock.calls[0][0];
    expect(request.organizationKey).toBe(TEST_ORG);
    expect(request.projectKey).toBe(TEST_PROJECT);
    expect(request.fileContent).toBe(FILE_CONTENT);
    expect(typeof request.filePath).toBe('string');
  });

  it('does not send branchName in request when no branch is provided', async () => {
    await analyzeSqaa({ file: 'src/index.ts' }, FAKE_AUTH);

    const request = analyzeFileSpy.mock.calls[0][0];
    // branchName: null causes a 400 from the real API — must be omitted entirely
    expect(request.branchName).toBeUndefined();
  });

  it('passes branch to client when --branch option is provided', async () => {
    await analyzeSqaa({ file: 'src/index.ts', branch: 'feature/my-branch' }, FAKE_AUTH);

    const request = analyzeFileSpy.mock.calls[0][0];
    expect(request.branchName).toBe('feature/my-branch');
  });

  it('displays success message when no issues found', async () => {
    analyzeFileSpy.mockResolvedValue({ id: 'a1', issues: [], errors: null });

    await analyzeSqaa({ file: 'src/index.ts' }, FAKE_AUTH);

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

    await analyzeSqaa({ file: 'main.py' }, FAKE_AUTH);

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
      errors: [{ code: 'NOT_ENTITLED', message: 'Organization not entitled to SQAA' }],
    });

    await analyzeSqaa({ file: 'src/index.ts' }, FAKE_AUTH);

    const output = getMockUiCalls()
      .map((c) => String(c.args[0]))
      .join('\n');
    expect(output).toContain('NOT_ENTITLED');
    expect(output).toContain('not entitled');
  });

  it('displays both issues and errors when response contains both', async () => {
    analyzeFileSpy.mockResolvedValue({
      id: 'a1',
      issues: [
        {
          rule: 'cpp:S1186',
          message: 'Add a nested comment explaining why this method is empty.',
          textRange: { startLine: 2, endLine: 2, startOffset: 28, endOffset: 30 },
        },
      ],
      errors: [{ code: 'PARSE_ERROR', message: "'NonExistentHeader.h' file not found" }],
    });

    await analyzeSqaa({ file: 'src/index.ts' }, FAKE_AUTH);

    const output = getMockUiCalls()
      .map((c) => String(c.args[0]))
      .join('\n');
    expect(output).toContain('cpp:S1186');
    expect(output).toContain('Add a nested comment');
    expect(output).toContain('PARSE_ERROR');
    expect(output).toContain('NonExistentHeader.h');
  });

  it('throws CommandFailedError when SQAA API call fails', () => {
    analyzeFileSpy.mockRejectedValue(new Error('Network error'));

    expect(analyzeSqaa({ file: 'src/index.ts' }, FAKE_AUTH)).rejects.toThrow(
      'SonarQube Agentic Analysis failed',
    );
  });
});

describe('analyzeSqaa: path normalization', () => {
  it('normalizes Windows-style backslash paths to forward slashes in the API request', async () => {
    await analyzeSqaa({ file: 'python\\scripts\\check_md_code_blocks.py' }, FAKE_AUTH);

    const request = analyzeFileSpy.mock.calls[0][0];
    expect(request.filePath).toBe('python/scripts/check_md_code_blocks.py');
  });
  it('throws InvalidOptionError when file is outside the current working directory', () => {
    const differentDrive =
      process.platform === 'win32' ? 'D:\\other-project\\file.ts' : '/other-project/file.ts';

    expect(analyzeSqaa({ file: '../outside.ts' }, FAKE_AUTH)).rejects.toThrow(InvalidOptionError);
    expect(analyzeSqaa({ file: differentDrive }, FAKE_AUTH)).rejects.toThrow(InvalidOptionError);
  });
});

// ─── analyzeSqaa: explicit --project option ──────────────────────────────────

describe('analyzeSqaa: explicit --project option', () => {
  it('uses provided project key directly without consulting extensions registry', async () => {
    loadStateSpy.mockReturnValue(makeCloudStateNoExt());

    await analyzeSqaa({ file: 'src/index.ts', project: 'explicit-project' }, FAKE_AUTH);

    expect(analyzeFileSpy).toHaveBeenCalledTimes(1);
    expect(analyzeFileSpy.mock.calls[0][0].projectKey).toBe('explicit-project');
  });

  it('uses provided project key even when extension has a different project key', async () => {
    await analyzeSqaa({ file: 'src/index.ts', project: 'override-project' }, FAKE_AUTH);

    expect(analyzeFileSpy).toHaveBeenCalledTimes(1);
    expect(analyzeFileSpy.mock.calls[0][0].projectKey).toBe('override-project');
  });

  it('throws CommandFailedError when --project given but on-premise server', () => {
    const onPremiseAuth = {
      token: TEST_TOKEN,
      serverUrl: 'https://mysonar.company.com',
      orgKey: TEST_ORG,
      connectionType: 'on-premise' as const,
    };

    expect(
      analyzeSqaa({ file: 'src/index.ts', project: 'my-project' }, onPremiseAuth),
    ).rejects.toThrow(CommandFailedError);
  });
});

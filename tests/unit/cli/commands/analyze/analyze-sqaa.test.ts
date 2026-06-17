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

import * as fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import {
  CommandFailedError,
  InvalidOptionError,
} from '../../../../../src/cli/commands/_common/error.js';
import { analyzeSqaa } from '../../../../../src/cli/commands/analyze/sqaa';
import * as processLib from '../../../../../src/lib/process.js';
import * as stateRepository from '../../../../../src/lib/repository/state-repository.js';
import { getDefaultState } from '../../../../../src/lib/state.js';
import * as stateManager from '../../../../../src/lib/state-manager.js';
import { SonarQubeClient } from '../../../../../src/sonarqube/client.js';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../src/ui';

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
let createAnalysisSpy: ReturnType<typeof spyOn>;
let spawnProcessSpy: ReturnType<typeof spyOn>;

/** Cloud state WITH a sonar-sqaa extension entry for the current project root */
function makeCloudState() {
  const state = getDefaultState('test');
  stateManager.addOrUpdateConnection(state, SONARCLOUD_URL, 'cloud', {
    orgKey: TEST_ORG,
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

beforeEach(() => {
  setMockUi(true);
  clearMockUiCalls();

  loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeCloudState());
  saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => undefined);

  existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
  readFileSpy = spyOn(fs, 'readFileSync').mockReturnValue(FILE_CONTENT);

  createAnalysisSpy = spyOn(SonarQubeClient.prototype, 'createAnalysis').mockResolvedValue({
    id: 'analysis-1',
    issues: [],
    errors: null,
  });

  // Mock the git-based repo-root resolver so unit tests don't shell out to git.
  // Without this, parallel Bun test workers each spawn `git rev-parse --show-toplevel`
  // and the OS-level contention causes intermittent flakes. We return process.cwd()
  // so the registered extension's projectRoot still matches the lookup key.
  spawnProcessSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
    exitCode: 0,
    stdout: process.cwd() + '\n',
    stderr: '',
  });
});

afterEach(() => {
  setMockUi(false);
  process.exitCode = 0;
  loadStateSpy.mockRestore();
  saveStateSpy.mockRestore();
  existsSpy.mockRestore();
  readFileSpy.mockRestore();
  createAnalysisSpy.mockRestore();
  spawnProcessSpy.mockRestore();
});

// ─── analyzeSqaa ─────────────────────────────────────────────────────────────

describe('analyzeSqaa: input validation', () => {
  it('throws InvalidOptionError when file does not exist', () => {
    existsSpy.mockReturnValue(false);

    expect(analyzeSqaa({ file: ['nonexistent.ts'] }, FAKE_AUTH)).rejects.toThrow(
      InvalidOptionError,
    );
    expect(analyzeSqaa({ file: ['nonexistent.ts'] }, FAKE_AUTH)).rejects.toThrow('File not found');
  });
});

function stateWithExtensionMissingProjectKey() {
  const state = getDefaultState('test');
  stateManager.addOrUpdateConnection(state, SONARCLOUD_URL, 'cloud', {
    orgKey: TEST_ORG,
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
  return state;
}

describe('analyzeSqaa: auth resolution', () => {
  it('throws CommandFailedError when extension has no projectKey (explicit agentic)', async () => {
    loadStateSpy.mockReturnValue(stateWithExtensionMissingProjectKey());

    let thrown: unknown;
    await analyzeSqaa({ file: ['src/index.ts'] }, FAKE_AUTH).catch((err: unknown) => {
      thrown = err;
    });

    expect(thrown).toBeInstanceOf(CommandFailedError);
    expect((thrown as Error).message).toContain(
      'SonarQube Agentic Analysis requires a project, but none is configured for this directory.',
    );
    expect(createAnalysisSpy).not.toHaveBeenCalled();
  });

  it('skips SQAA and warns when extension has no projectKey and requireProject is false (bare analyze)', async () => {
    loadStateSpy.mockReturnValue(stateWithExtensionMissingProjectKey());

    await analyzeSqaa({ file: ['src/index.ts'] }, FAKE_AUTH, { requireProject: false });

    expect(createAnalysisSpy).not.toHaveBeenCalled();
    const output = getMockUiCalls()
      .map((c) => String(c.args[0]))
      .join('\n');
    expect(output).toContain(
      'SonarQube Agentic Analysis skipped: no project configured. Specify one with --project or run: sonar integrate',
    );
  });
});

describe('analyzeSqaa: API call and result display', () => {
  it('calls client.createAnalysis with correct parameters', async () => {
    await analyzeSqaa({ file: ['src/index.ts'] }, FAKE_AUTH);

    expect(createAnalysisSpy).toHaveBeenCalledTimes(1);
    const request = createAnalysisSpy.mock.calls[0][0];
    expect(request.organizationKey).toBe(TEST_ORG);
    expect(request.projectKey).toBe(TEST_PROJECT);
    expect(request.files).toEqual([{ path: expect.any(String) as string, content: FILE_CONTENT }]);
    expect(request.analysisDepth).toBeUndefined();
  });

  it('does not send branchName in request when no branch is provided', async () => {
    await analyzeSqaa({ file: ['src/index.ts'] }, FAKE_AUTH);

    const request = createAnalysisSpy.mock.calls[0][0];
    // branchName: null causes a 400 from the real API — must be omitted entirely
    expect(request.branchName).toBeUndefined();
  });

  it('passes branch to client when --branch option is provided', async () => {
    await analyzeSqaa({ file: ['src/index.ts'], branch: 'feature/my-branch' }, FAKE_AUTH);

    const request = createAnalysisSpy.mock.calls[0][0];
    expect(request.branchName).toBe('feature/my-branch');
  });

  it('renders per-file failure rows when a single --file analysis fails', async () => {
    createAnalysisSpy.mockRejectedValue(new Error('Network error'));

    await analyzeSqaa({ file: ['src/index.ts'] }, FAKE_AUTH);

    expect(createAnalysisSpy).toHaveBeenCalledTimes(1);
    const lines = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(lines.some((line) => line.includes('src/index.ts'))).toBe(true);
    expect(lines.some((line) => line.includes('Network error'))).toBe(true);
    expect(lines.some((line) => line.includes('SonarQube Agentic Analysis failed'))).toBe(false);
    expect(lines.at(-1)).toContain('1 failure');
    expect(process.exitCode).toBe(1);
  });

  it('renders file row and summary footer for a clean single-file result', async () => {
    await analyzeSqaa({ file: ['src/index.ts'] }, FAKE_AUTH);

    const lines = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(lines.some((line) => line.includes('src/index.ts'))).toBe(true);
    expect(lines.some((line) => line.includes('No issues found'))).toBe(true);
    expect(lines.at(-1)).toContain('1 files analyzed');
  });
});

describe('analyzeSqaa: path normalization', () => {
  it('normalizes Windows-style backslash paths to forward slashes in the API request', async () => {
    await analyzeSqaa({ file: [String.raw`python\scripts\check_md_code_blocks.py`] }, FAKE_AUTH);

    const request = createAnalysisSpy.mock.calls[0][0];
    expect(request.files[0].path).toBe('python/scripts/check_md_code_blocks.py');
  });
  it('throws InvalidOptionError when file is outside the current working directory', () => {
    const differentDrive =
      process.platform === 'win32'
        ? String.raw`D:\other-project\file.ts`
        : '/other-project/file.ts';

    expect(analyzeSqaa({ file: ['../outside.ts'] }, FAKE_AUTH)).rejects.toThrow(InvalidOptionError);
    expect(analyzeSqaa({ file: [differentDrive] }, FAKE_AUTH)).rejects.toThrow(InvalidOptionError);
  });
});

// ─── analyzeSqaa: explicit --project option ──────────────────────────────────

describe('analyzeSqaa: explicit --project option', () => {
  it('throws CommandFailedError when --project given but on-premise server', () => {
    const onPremiseAuth = {
      token: TEST_TOKEN,
      serverUrl: 'https://mysonar.company.com',
      orgKey: TEST_ORG,
      connectionType: 'on-premise' as const,
    };

    expect(
      analyzeSqaa({ file: ['src/index.ts'], project: 'my-project' }, onPremiseAuth),
    ).rejects.toThrow(CommandFailedError);
  });
});

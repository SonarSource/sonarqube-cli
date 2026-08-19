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

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CliAuthenticatedContext } from '@/commands/cli-context.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/command-error.ts';
import * as processLib from '@/core/process/process.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import { CliState, getDefaultState } from '@/core/state/state.ts';
import * as stateManager from '@/core/state/state-manager.ts';
import * as stateRepository from '@/core/state/state-repository.ts';
import { clearMockUiCalls, getMockUiCalls, setMockTty, setMockUi } from '@/core/ui';

import { analyzeSqaa, buildSqaaJsonReport } from '../../../../src/commands/analyze/sqaa.ts';
import * as changesetModule from '../../../../src/commands/analyze/sqaa-changeset.ts';
import { SQAA_HOOK_FEATURE_ID } from '../../../../src/commands/integrate/_common/features/sqaa-instructions-feature.ts';
import { CLAUDE_INTEGRATION_ID } from '../../../../src/commands/integrate/claude/declaration.ts';

const SONARCLOUD_URL = 'https://sonarcloud.io';
const TEST_ORG = 'test-org';
const TEST_PROJECT = 'my-project';
const TEST_TOKEN = 'squ_test_token';
const FILE_CONTENT = 'const x = 1;\n';

/** Fake auth for a cloud connection */
const FAKE_AUTH: import('@/core/auth/auth-resolver.ts').ResolvedAuth = {
  token: TEST_TOKEN,
  serverUrl: SONARCLOUD_URL,
  orgKey: TEST_ORG,
  connectionType: 'cloud',
};

const FAKE_AUTHENTICATED_CONTEXT = new CliAuthenticatedContext(FAKE_AUTH);

let loadStateSpy: ReturnType<typeof spyOn>;
let saveStateSpy: ReturnType<typeof spyOn>;
let existsSpy: ReturnType<typeof spyOn>;
let statSyncSpy: ReturnType<typeof spyOn>;
let readFileSpy: ReturnType<typeof spyOn>;
let createAnalysisSpy: ReturnType<typeof spyOn>;
let spawnProcessSpy: ReturnType<typeof spyOn>;

/**
 * Seed a declarative Claude Code integration whose project-scoped
 * `sonar-sqaa-hook` feature carries the given `projectKey` attr (or none).
 */
function seedClaudeSqaaFeature(state: CliState, projectKey: string | undefined) {
  const now = new Date().toISOString();
  state.integrations.installed.push({
    id: randomUUID(),
    integrationId: CLAUDE_INTEGRATION_ID,
    installedByCliVersion: '1.0.0',
    installedAt: now,
    updatedByCliVersion: '1.0.0',
    updatedAt: now,
    features: [
      {
        featureId: SQAA_HOOK_FEATURE_ID,
        scope: 'project',
        targetRoot: process.cwd(),
        installedByCliVersion: '1.0.0',
        installedAt: now,
        updatedByCliVersion: '1.0.0',
        updatedAt: now,
        dependencies: [],
        resources: [],
        operations: [],
        attrs: projectKey === undefined ? {} : { projectKey },
      },
    ],
  });
}

/** Cloud state WITH a sonar-sqaa hook feature for the current project root */
function makeCloudState() {
  const state = getDefaultState('test');
  stateManager.addOrUpdateConnection(state, SONARCLOUD_URL, 'cloud', {
    orgKey: TEST_ORG,
  });
  seedClaudeSqaaFeature(state, TEST_PROJECT);
  return state;
}

beforeEach(() => {
  setMockUi(true);
  setMockTty(false);
  clearMockUiCalls();

  loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(makeCloudState());
  saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => undefined);

  existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
  statSyncSpy = spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as fs.Stats);
  readFileSpy = spyOn(fs, 'readFileSync').mockReturnValue(FILE_CONTENT);

  createAnalysisSpy = spyOn(SonarQubeClient.prototype, 'createAnalysis').mockResolvedValue({
    id: 'analysis-1',
    issues: [],
    errors: null,
  });

  // Mock git subprocess calls so unit tests don't shell out to git.
  spawnProcessSpy = spyOn(processLib, 'spawnProcess').mockImplementation(
    (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return Promise.resolve({ exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' });
      }
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return Promise.resolve({ exitCode: 0, stdout: '\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' });
    },
  );
});

afterEach(() => {
  setMockUi(false);
  process.exitCode = 0;
  loadStateSpy.mockRestore();
  saveStateSpy.mockRestore();
  existsSpy.mockRestore();
  statSyncSpy.mockRestore();
  readFileSpy.mockRestore();
  createAnalysisSpy.mockRestore();
  spawnProcessSpy.mockRestore();
});

// ─── analyzeSqaa ─────────────────────────────────────────────────────────────

describe('analyzeSqaa: input validation', () => {
  it('throws InvalidOptionError when file does not exist', async () => {
    statSyncSpy.mockReturnValue(undefined);

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      analyzeSqaa({ file: ['nonexistent.ts'] }, FAKE_AUTHENTICATED_CONTEXT),
    ).rejects.toThrow(InvalidOptionError);
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      analyzeSqaa({ file: ['nonexistent.ts'] }, FAKE_AUTHENTICATED_CONTEXT),
    ).rejects.toThrow('File not found');
  });
});

function stateWithSqaaFeatureMissingProjectKey() {
  const state = getDefaultState('test');
  stateManager.addOrUpdateConnection(state, SONARCLOUD_URL, 'cloud', {
    orgKey: TEST_ORG,
  });
  // Feature exists but projectKey attr is absent
  seedClaudeSqaaFeature(state, undefined);
  return state;
}

describe('analyzeSqaa: auth resolution', () => {
  it('throws CommandFailedError when the SQAA feature has no projectKey (explicit agentic)', async () => {
    loadStateSpy.mockReturnValue(stateWithSqaaFeatureMissingProjectKey());

    let thrown: unknown;
    await analyzeSqaa({ file: ['src/index.ts'] }, FAKE_AUTHENTICATED_CONTEXT).catch(
      (err: unknown) => {
        thrown = err;
      },
    );

    expect(thrown).toBeInstanceOf(CommandFailedError);
    expect((thrown as Error).message).toContain(
      'Vortex analysis requires a project, but none is configured for this directory.',
    );
    expect(createAnalysisSpy).not.toHaveBeenCalled();
  });

  it('skips SQAA and warns when the SQAA feature has no projectKey and requireProject is false (bare analyze)', async () => {
    loadStateSpy.mockReturnValue(stateWithSqaaFeatureMissingProjectKey());

    await analyzeSqaa({ file: ['src/index.ts'] }, FAKE_AUTHENTICATED_CONTEXT, {
      requireProject: false,
    });

    expect(createAnalysisSpy).not.toHaveBeenCalled();
    const output = getMockUiCalls()
      .map((c) => String(c.args[0]))
      .join('\n');
    expect(output).toContain(
      'Vortex analysis skipped: no project configured. Specify one with --project or run: sonar integrate',
    );
  });
});

/**
 * Cloud state with two project-scoped SQAA features that both resolve to the
 * current directory, but via different signals: the first (array order) matches
 * only on `repoRoot` (as if a sibling worktree integrated with a different key
 * shares this main working tree); the second matches exactly on `targetRoot`
 * (the install actually rooted here). The exact targetRoot match must win.
 */
function stateWithTargetAndRepoRootSqaaFeatures(
  repoRootOnlyKey: string,
  targetRootKey: string,
): CliState {
  const state = getDefaultState('test');
  stateManager.addOrUpdateConnection(state, SONARCLOUD_URL, 'cloud', { orgKey: TEST_ORG });
  const now = new Date().toISOString();
  const makeFeature = (targetRoot: string, projectKey: string) => ({
    featureId: SQAA_HOOK_FEATURE_ID,
    scope: 'project' as const,
    targetRoot,
    installedByCliVersion: '1.0.0',
    installedAt: now,
    updatedByCliVersion: '1.0.0',
    updatedAt: now,
    dependencies: [],
    resources: [],
    operations: [],
    attrs: { projectKey, repoRoot: process.cwd() },
  });
  state.integrations.installed.push({
    id: randomUUID(),
    integrationId: CLAUDE_INTEGRATION_ID,
    installedByCliVersion: '1.0.0',
    installedAt: now,
    updatedByCliVersion: '1.0.0',
    updatedAt: now,
    features: [
      // repoRoot-only match listed first — would win on array order under a
      // combined targetRoot-OR-repoRoot search.
      makeFeature('/some/other/worktree', repoRootOnlyKey),
      makeFeature(process.cwd(), targetRootKey),
    ],
  });
  return state;
}

describe('analyzeSqaa: project-key resolution across worktrees', () => {
  it('prefers a targetRoot match over a repoRoot-only match regardless of feature order', async () => {
    loadStateSpy.mockReturnValue(
      stateWithTargetAndRepoRootSqaaFeatures('wrong-worktree-key', 'right-here-key'),
    );

    await analyzeSqaa({ file: ['src/index.ts'] }, FAKE_AUTHENTICATED_CONTEXT);

    expect(createAnalysisSpy).toHaveBeenCalledTimes(1);
    expect(createAnalysisSpy.mock.calls[0][0].projectKey).toBe('right-here-key');
  });
});

describe('analyzeSqaa: API call and result display', () => {
  it('calls client.createAnalysis with correct parameters', async () => {
    await analyzeSqaa({ file: ['src/index.ts'] }, FAKE_AUTHENTICATED_CONTEXT);

    expect(createAnalysisSpy).toHaveBeenCalledTimes(1);
    const request = createAnalysisSpy.mock.calls[0][0];
    expect(request.organizationKey).toBe(TEST_ORG);
    expect(request.projectKey).toBe(TEST_PROJECT);
    expect(request.files).toEqual([{ path: expect.any(String) as string, content: FILE_CONTENT }]);
    expect(request.analysisDepth).toBeUndefined();
  });

  it('does not send branchName in request when no branch is provided and git has no current branch', async () => {
    await analyzeSqaa({ file: ['src/index.ts'] }, FAKE_AUTHENTICATED_CONTEXT);

    const request = createAnalysisSpy.mock.calls[0][0];
    // branchName: null causes a 400 from the real API — must be omitted entirely
    expect(request.branchName).toBeUndefined();
  });

  it('auto-detects branchName from git when --branch is omitted', async () => {
    spawnProcessSpy.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return Promise.resolve({ exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' });
      }
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return Promise.resolve({ exitCode: 0, stdout: 'feature/auto-detect\n', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' });
    });

    await analyzeSqaa({ file: ['src/index.ts'] }, FAKE_AUTHENTICATED_CONTEXT);

    const request = createAnalysisSpy.mock.calls[0][0];
    expect(request.branchName).toBe('feature/auto-detect');
  });

  it('passes branch to client when --branch option is provided', async () => {
    await analyzeSqaa(
      { file: ['src/index.ts'], branch: 'feature/my-branch' },
      FAKE_AUTHENTICATED_CONTEXT,
    );

    const request = createAnalysisSpy.mock.calls[0][0];
    expect(request.branchName).toBe('feature/my-branch');
  });

  it('renders per-file failure rows when a single --file analysis fails', async () => {
    createAnalysisSpy.mockRejectedValue(new Error('Network error'));

    await analyzeSqaa({ file: ['src/index.ts'] }, FAKE_AUTHENTICATED_CONTEXT);

    expect(createAnalysisSpy).toHaveBeenCalledTimes(1);
    const lines = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(lines.some((line) => line.includes('src/index.ts'))).toBe(true);
    expect(lines.some((line) => line.includes('Network error'))).toBe(true);
    expect(lines.some((line) => line.includes('Vortex analysis failed'))).toBe(false);
    expect(lines.at(-1)).toContain('1 failure');
    expect(process.exitCode).toBe(1);
  });

  it('renders file row and summary footer for a clean single-file result', async () => {
    await analyzeSqaa({ file: ['src/index.ts'] }, FAKE_AUTHENTICATED_CONTEXT);

    const lines = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(lines.some((line) => line.includes('src/index.ts'))).toBe(true);
    expect(lines.some((line) => line.includes('No issues found'))).toBe(true);
    expect(lines.at(-1)).toContain('1 files analyzed · STANDARD analysis');
  });
});

describe('analyzeSqaa: path normalization', () => {
  it('normalizes Windows-style backslash paths to forward slashes in the API request', async () => {
    await analyzeSqaa(
      { file: [String.raw`python\scripts\check_md_code_blocks.py`] },
      FAKE_AUTHENTICATED_CONTEXT,
    );

    const request = createAnalysisSpy.mock.calls[0][0];
    expect(request.files[0].path).toBe('python/scripts/check_md_code_blocks.py');
  });
  it('throws InvalidOptionError when file is outside the current working directory', async () => {
    const differentDrive =
      process.platform === 'win32'
        ? String.raw`D:\other-project\file.ts`
        : '/other-project/file.ts';

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      analyzeSqaa({ file: ['../outside.ts'] }, FAKE_AUTHENTICATED_CONTEXT),
    ).rejects.toThrow(InvalidOptionError);
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      analyzeSqaa({ file: [differentDrive] }, FAKE_AUTHENTICATED_CONTEXT),
    ).rejects.toThrow(InvalidOptionError);
  });
});

// ─── analyzeSqaa: explicit --project option ──────────────────────────────────

describe('analyzeSqaa: explicit --project option', () => {
  it('throws CommandFailedError when --project given but on-premise server', async () => {
    const onPremiseAuth = {
      token: TEST_TOKEN,
      serverUrl: 'https://mysonar.company.com',
      orgKey: TEST_ORG,
      connectionType: 'on-premise' as const,
    };

    const onPremiseContext = new CliAuthenticatedContext(onPremiseAuth);

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      analyzeSqaa({ file: ['src/index.ts'], project: 'my-project' }, onPremiseContext),
    ).rejects.toThrow(CommandFailedError);
  });
});

describe('buildSqaaJsonReport', () => {
  it('returns a single-file JSON report with forcedDepth STANDARD', async () => {
    const report = await buildSqaaJsonReport(
      { file: ['src/index.ts'], forcedDepth: 'STANDARD' },
      FAKE_AUTH,
    );

    expect(report).not.toBeNull();
    expect(report?.analysisDepth).toBe('STANDARD');
    expect(createAnalysisSpy.mock.calls[0][0].analysisDepth).toBeUndefined();
  });

  it('defaults multi-file reports to DEEP analysisDepth', async () => {
    const report = await buildSqaaJsonReport({ file: ['src/a.ts', 'src/b.ts'] }, FAKE_AUTH);

    expect(report).not.toBeNull();
    expect(report?.analysisDepth).toBe('DEEP');
    expect(createAnalysisSpy.mock.calls[0][0].analysisDepth).toBe('DEEP');
  });

  it('returns null when SQAA is unavailable (non-Cloud)', async () => {
    const onPremiseAuth = {
      token: TEST_TOKEN,
      serverUrl: 'https://mysonar.company.com',
      orgKey: TEST_ORG,
      connectionType: 'on-premise' as const,
    };

    const report = await buildSqaaJsonReport({ file: ['src/index.ts'] }, onPremiseAuth);
    expect(report).toBeNull();
    expect(createAnalysisSpy).not.toHaveBeenCalled();
  });

  it('returns a failure entry when the API call fails', async () => {
    createAnalysisSpy.mockRejectedValue(new Error('Network error'));

    const report = await buildSqaaJsonReport({ file: ['src/index.ts'] }, FAKE_AUTH);

    expect(report?.failures).toHaveLength(1);
    expect(report?.failures[0].message).toContain('Network error');
  });

  it('throws InvalidOptionError for invalid --depth', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      buildSqaaJsonReport({ file: ['src/index.ts'], depth: 'INVALID' }, FAKE_AUTH),
    ).rejects.toThrow(InvalidOptionError);
  });
});

describe('analyzeSqaa: depth option', () => {
  it('throws InvalidOptionError for invalid --depth', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      analyzeSqaa({ file: ['src/index.ts'], depth: 'INVALID' }, FAKE_AUTHENTICATED_CONTEXT),
    ).rejects.toThrow(InvalidOptionError);
  });

  it('sends DEEP on the wire when --depth DEEP is set for a single file', async () => {
    await analyzeSqaa({ file: ['src/index.ts'], depth: 'DEEP' }, FAKE_AUTHENTICATED_CONTEXT);

    expect(createAnalysisSpy.mock.calls[0][0].analysisDepth).toBe('DEEP');
  });
});

describe('analyzeSqaa: change-set mode', () => {
  let resolveChangeSetSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resolveChangeSetSpy = spyOn(changesetModule, 'resolveChangeSet');
  });

  afterEach(() => {
    resolveChangeSetSpy.mockRestore();
  });

  it('reports when the change set is empty', async () => {
    resolveChangeSetSpy.mockResolvedValue({
      files: [],
      ignored: [],
      repoRoot: process.cwd(),
    });

    await analyzeSqaa({ staged: true }, FAKE_AUTHENTICATED_CONTEXT);

    const output = getMockUiCalls()
      .map((c) => String(c.args[0]))
      .join('\n');
    expect(output).toContain('no files in the change set to analyze');
    expect(createAnalysisSpy).not.toHaveBeenCalled();
  });

  it('buildSqaaJsonReport returns an empty report when the change set has no analyzable files', async () => {
    resolveChangeSetSpy.mockResolvedValue({
      files: [],
      ignored: [{ path: 'large.bin', reason: 'binary' as const }],
      repoRoot: process.cwd(),
    });

    const report = await buildSqaaJsonReport({ staged: true }, FAKE_AUTH);

    expect(report?.files).toHaveLength(0);
    expect(report?.ignored).toHaveLength(1);
    expect(createAnalysisSpy).not.toHaveBeenCalled();
  });

  it('analyzes files from the change set when present', async () => {
    const filePath = `${process.cwd()}/src/index.ts`;
    resolveChangeSetSpy.mockResolvedValue({
      files: [filePath],
      ignored: [],
      repoRoot: process.cwd(),
    });

    await analyzeSqaa({ staged: true }, FAKE_AUTHENTICATED_CONTEXT);

    expect(createAnalysisSpy).toHaveBeenCalledTimes(1);
    expect(createAnalysisSpy.mock.calls[0][0].analysisDepth).toBe('DEEP');
  });
});

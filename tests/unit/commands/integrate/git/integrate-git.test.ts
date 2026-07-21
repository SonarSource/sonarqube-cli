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

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import {
  CommandFailedError,
  InvalidOptionError,
} from '../../../../../src/commands/_common/error.ts';
import * as binaryInstall from '../../../../../src/commands/_common/install/binary.ts';
import * as preflightSummary from '../../../../../src/commands/integrate/_common/preflight-summary.ts';
import {
  detectSonarHookInstallation as detectHookInstallation,
  hasMarker,
  integrateGit,
  type IntegrateGitOptions,
  isGitHookType,
  resolveGitHooksDir,
} from '../../../../../src/commands/integrate/git';
import {
  getNativeHookMarker,
  getRecognizedNativeMarkers,
} from '../../../../../src/commands/integrate/git/tools/native';
import { PRE_COMMIT_CONFIG_FILE } from '../../../../../src/commands/integrate/git/tools/pre-commit';
import { LEGACY_HOOK_MARKER } from '../../../../../src/commands/integrate/git/tools/shared.ts';
import {
  clearMockUiCalls,
  getMockUiCalls,
  queueMockResponse,
  setMockUi,
} from '../../../../../src/core/ui';
import { GLOBAL_HOOKS_DIR } from '../../../../../src/lib/config-constants.ts';
import * as processLib from '../../../../../src/lib/process.ts';
import * as discovery from '../../../../../src/lib/project-workspace';
import * as stateRepository from '../../../../../src/lib/repository/state-repository.ts';
import { type CliState, getDefaultState } from '../../../../../src/lib/state.ts';

const TEMP_DIR = join(process.cwd(), 'tests', 'unit', '.integrate-git-tmp');

/** Simulate `git config core.hooksPath` returning "not set" (exit code 1). */
const NO_HOOKS_PATH = { exitCode: 1, stdout: '', stderr: '' };

describe('isGitHookType', () => {
  it('returns true for valid hook types and false otherwise', () => {
    expect(isGitHookType('pre-commit')).toBe(true);
    expect(isGitHookType('pre-push')).toBe(true);
    expect(isGitHookType('commit-msg')).toBe(false);
    expect(isGitHookType('')).toBe(false);
  });
});

describe('hasMarker', () => {
  it('returns true when the file contains a current or legacy recognized marker', () => {
    mkdirSync(TEMP_DIR, { recursive: true });
    const legacy = join(TEMP_DIR, 'legacy');
    const current = join(TEMP_DIR, 'current');
    const foreign = join(TEMP_DIR, 'foreign');
    writeFileSync(legacy, `#!/bin/sh\n# ${LEGACY_HOOK_MARKER}\n`);
    writeFileSync(current, `#!/bin/sh\n# ${getNativeHookMarker('pre-commit')}\n`);
    writeFileSync(foreign, '#!/bin/sh\necho hello\n');

    const markers = getRecognizedNativeMarkers('pre-commit');
    expect(hasMarker(legacy, markers)).toBe(true);
    expect(hasMarker(current, markers)).toBe(true);
    expect(hasMarker(foreign, markers)).toBe(false);
    expect(hasMarker(join(TEMP_DIR, 'nonexistent'), markers)).toBe(false);

    rmSync(TEMP_DIR, { recursive: true, force: true });
  });
});

describe('resolveGitHooksDir', () => {
  it('returns <root>/.git/hooks when .git is a directory and core.hooksPath is not set', async () => {
    mkdirSync(join(TEMP_DIR, '.git', 'hooks'), { recursive: true });

    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(NO_HOOKS_PATH);

    try {
      const result = await resolveGitHooksDir(TEMP_DIR);
      expect(result).toBe(join(TEMP_DIR, '.git', 'hooks'));
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('returns core.hooksPath when it is configured', async () => {
    mkdirSync(join(TEMP_DIR, '.git', 'hooks'), { recursive: true });

    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: '.husky\n',
      stderr: '',
    });

    try {
      const result = await resolveGitHooksDir(TEMP_DIR);
      expect(result).toBe(join(TEMP_DIR, '.husky'));
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('throws CommandFailedError when git rev-parse exits with non-zero code', () => {
    mkdirSync(TEMP_DIR, { recursive: true });
    writeFileSync(join(TEMP_DIR, '.git'), 'gitdir: /some/real/.git/worktrees/foo\n');

    // Both git config and git rev-parse return non-zero → falls through to rev-parse error
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    });

    try {
      expect(resolveGitHooksDir(TEMP_DIR)).rejects.toThrow(
        'Could not resolve git hooks directory (exit code 128)',
      );
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('returns absolute path from git rev-parse as-is when it starts with /', async () => {
    mkdirSync(TEMP_DIR, { recursive: true });
    writeFileSync(join(TEMP_DIR, '.git'), 'gitdir: /abs/.git/worktrees/foo\n');

    const spawnSpy = spyOn(processLib, 'spawnProcess')
      .mockResolvedValueOnce(NO_HOOKS_PATH) // git config core.hooksPath → not set
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '/abs/.git/worktrees/foo/hooks\n',
        stderr: '',
      }); // git rev-parse

    try {
      const result = await resolveGitHooksDir(TEMP_DIR);
      expect(result).toBe('/abs/.git/worktrees/foo/hooks');
      expect(isAbsolute(result)).toBe(true);
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('joins relative path from git rev-parse with root when it does not start with /', async () => {
    mkdirSync(TEMP_DIR, { recursive: true });
    writeFileSync(join(TEMP_DIR, '.git'), 'gitdir: .git/worktrees/foo\n');

    const spawnSpy = spyOn(processLib, 'spawnProcess')
      .mockResolvedValueOnce(NO_HOOKS_PATH) // git config core.hooksPath → not set
      .mockResolvedValueOnce({ exitCode: 0, stdout: '.git/worktrees/foo/hooks\n', stderr: '' }); // git rev-parse

    try {
      const result = await resolveGitHooksDir(TEMP_DIR);
      expect(result).toBe(join(TEMP_DIR, '.git/worktrees/foo/hooks'));
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('returns the path from git rev-parse when .git is a file (worktree)', async () => {
    mkdirSync(TEMP_DIR, { recursive: true });
    writeFileSync(join(TEMP_DIR, '.git'), 'gitdir: /some/real/.git/worktrees/foo\n');

    const spawnSpy = spyOn(processLib, 'spawnProcess')
      .mockResolvedValueOnce(NO_HOOKS_PATH) // git config core.hooksPath → not set
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '/some/real/.git/worktrees/foo/hooks\n',
        stderr: '',
      }); // git rev-parse

    try {
      const result = await resolveGitHooksDir(TEMP_DIR);
      expect(result).toBe('/some/real/.git/worktrees/foo/hooks');
      expect(spawnSpy).toHaveBeenCalledWith('git', ['rev-parse', '--git-path', 'hooks'], {
        cwd: TEMP_DIR,
      });
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });
});

describe('detectHookInstallation', () => {
  it('sets gitPreCommit and gitPrePush when hooks are in .git/hooks', async () => {
    mkdirSync(join(TEMP_DIR, '.git', 'hooks'), { recursive: true });
    writeFileSync(
      join(TEMP_DIR, '.git', 'hooks', 'pre-commit'),
      `#!/bin/sh\n# ${LEGACY_HOOK_MARKER}\n`,
    );
    writeFileSync(
      join(TEMP_DIR, '.git', 'hooks', 'pre-push'),
      `#!/bin/sh\n# ${LEGACY_HOOK_MARKER}\n`,
    );

    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(NO_HOOKS_PATH);

    try {
      const result = await detectHookInstallation(TEMP_DIR);
      expect(result.gitPreCommit).toBe(true);
      expect(result.gitPrePush).toBe(true);
      expect(result.huskyPreCommit).toBe(false);
      expect(result.huskyPrePush).toBe(false);
      expect(result.preCommitConfig).toBe(false);
      expect(result.hooksDir).toBe(join(TEMP_DIR, '.git', 'hooks'));
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('returns all false when no hooks are installed', async () => {
    mkdirSync(join(TEMP_DIR, '.git', 'hooks'), { recursive: true });

    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(NO_HOOKS_PATH);

    try {
      const result = await detectHookInstallation(TEMP_DIR);
      expect(result.gitPreCommit).toBe(false);
      expect(result.gitPrePush).toBe(false);
      expect(result.huskyPreCommit).toBe(false);
      expect(result.huskyPrePush).toBe(false);
      expect(result.preCommitConfig).toBe(false);
      expect(result.hooksDir).toBe(join(TEMP_DIR, '.git', 'hooks'));
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('returns gitPreCommit and gitPrePush false when hook files exist but have no marker', async () => {
    mkdirSync(join(TEMP_DIR, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(TEMP_DIR, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hello\n');
    writeFileSync(join(TEMP_DIR, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho hello\n');

    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(NO_HOOKS_PATH);

    try {
      const result = await detectHookInstallation(TEMP_DIR);
      expect(result.gitPreCommit).toBe(false);
      expect(result.gitPrePush).toBe(false);
      expect(result.huskyPreCommit).toBe(false);
      expect(result.huskyPrePush).toBe(false);
      expect(result.preCommitConfig).toBe(false);
      expect(result.hooksDir).toBe(join(TEMP_DIR, '.git', 'hooks'));
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('sets huskyPreCommit and huskyPrePush when husky is used', async () => {
    mkdirSync(join(TEMP_DIR, '.husky'), { recursive: true });
    writeFileSync(join(TEMP_DIR, '.husky', 'pre-commit'), `#!/bin/sh\n# ${LEGACY_HOOK_MARKER}\n`);
    writeFileSync(join(TEMP_DIR, '.husky', 'pre-push'), `#!/bin/sh\n# ${LEGACY_HOOK_MARKER}\n`);

    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: '.husky\n',
      stderr: '',
    });

    try {
      const result = await detectHookInstallation(TEMP_DIR);
      expect(result.huskyPreCommit).toBe(true);
      expect(result.huskyPrePush).toBe(true);
      expect(result.gitPreCommit).toBe(false);
      expect(result.gitPrePush).toBe(false);
      expect(result.preCommitConfig).toBe(false);
      expect(result.hooksDir).toBe(join(TEMP_DIR, '.husky'));
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('sets preCommitConfig true when .pre-commit-config.yaml contains sonar-secrets hook', async () => {
    mkdirSync(TEMP_DIR, { recursive: true });
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      'repos:\n  - repo: local\n    hooks:\n      - id: sonar-secrets\n        name: Sonar secrets scan\n        entry: sonar analyze secrets\n        language: system\n',
    );

    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(NO_HOOKS_PATH);

    try {
      const result = await detectHookInstallation(TEMP_DIR);
      expect(result.preCommitConfig).toBe(true);
      expect(result.gitPreCommit).toBe(false);
      expect(result.gitPrePush).toBe(false);
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('sets preCommitConfig false when .pre-commit-config.yaml exists but has no sonar-secrets hook', async () => {
    mkdirSync(TEMP_DIR, { recursive: true });
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      'repos:\n  - repo: local\n    hooks:\n      - id: some-other-hook\n        name: Some other hook\n        entry: echo hello\n        language: system\n',
    );

    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(NO_HOOKS_PATH);

    try {
      const result = await detectHookInstallation(TEMP_DIR);
      expect(result.preCommitConfig).toBe(false);
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });
});

const MOCK_AUTH = {
  serverUrl: 'https://sonarqube.example.com',
  token: 'test-token',
  connectionType: 'on-premise' as const,
};

describe('integrateGit', () => {
  let findGitRootSpy: ReturnType<typeof spyOn>;
  let discoverProjectSpy: ReturnType<typeof spyOn>;
  let printGitPreflightSummarySpy: ReturnType<typeof spyOn>;
  let installBinarySpy: ReturnType<typeof spyOn>;
  let resolveBinaryPathSpy: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let state: CliState;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    findGitRootSpy = spyOn(discovery, 'findGitRoot');
    discoverProjectSpy = spyOn(discovery, 'discoverProject').mockResolvedValue({
      rootDir: TEMP_DIR,
      projectKey: undefined,
      isGitRepo: true,
      configSources: [],
    });
    printGitPreflightSummarySpy = spyOn(
      preflightSummary,
      'printGitPreflightSummary',
    ).mockResolvedValue(undefined);
    installBinarySpy = spyOn(binaryInstall, 'installBinary').mockResolvedValue({
      binaryPath: '/usr/local/bin/sonar-secrets',
      freshlyInstalled: true,
    });
    resolveBinaryPathSpy = spyOn(binaryInstall, 'resolveBinaryPath').mockReturnValue(null);
    state = getDefaultState('test');
    loadStateSpy = spyOn(stateRepository, 'loadState').mockImplementation(() => state);
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setMockUi(false);
    findGitRootSpy.mockRestore();
    discoverProjectSpy.mockRestore();
    printGitPreflightSummarySpy.mockRestore();
    installBinarySpy.mockRestore();
    resolveBinaryPathSpy.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
  });

  /* eslint-disable @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable */
  it('throws InvalidOptionError when --hook is invalid before git checks', async () => {
    await expect(
      integrateGit(
        { nonInteractive: true, hook: 'typo' } as unknown as IntegrateGitOptions,
        MOCK_AUTH,
      ),
    ).rejects.toBeInstanceOf(InvalidOptionError);
    await expect(
      integrateGit(
        { nonInteractive: true, hook: 'typo' } as unknown as IntegrateGitOptions,
        MOCK_AUTH,
      ),
    ).rejects.toThrow('--hook must be pre-commit or pre-push');
  });

  it('throws InvalidOptionError for invalid --hook on global install before other work', async () => {
    await expect(
      integrateGit(
        {
          global: true,
          nonInteractive: true,
          hook: 'typo',
        } as unknown as IntegrateGitOptions,
        MOCK_AUTH,
      ),
    ).rejects.toBeInstanceOf(InvalidOptionError);
    await expect(
      integrateGit(
        {
          global: true,
          nonInteractive: true,
          hook: 'typo',
        } as unknown as IntegrateGitOptions,
        MOCK_AUTH,
      ),
    ).rejects.toThrow('--hook must be pre-commit or pre-push');
  });

  it('throws InvalidOptionError when --global is combined with --dependency-risks', async () => {
    await expect(
      integrateGit(
        { global: true, nonInteractive: true, dependencyRisks: true, project: 'k' },
        MOCK_AUTH,
      ),
    ).rejects.toBeInstanceOf(InvalidOptionError);
    await expect(
      integrateGit(
        { global: true, nonInteractive: true, dependencyRisks: true, project: 'k' },
        MOCK_AUTH,
      ),
    ).rejects.toThrow('--dependency-risks and -p are not supported with --global');
  });

  it('throws InvalidOptionError when --global is combined with -p alone', async () => {
    await expect(
      integrateGit({ global: true, nonInteractive: true, project: 'k' }, MOCK_AUTH),
    ).rejects.toBeInstanceOf(InvalidOptionError);
  });
  /* eslint-enable @typescript-eslint/await-thenable */

  it('throws CommandFailedError when not inside a git repository', async () => {
    findGitRootSpy.mockReturnValue({ gitRoot: '/not-a-repo', isGit: false });
    /* eslint-disable @typescript-eslint/await-thenable */
    await expect(integrateGit({ nonInteractive: true }, MOCK_AUTH)).rejects.toThrow(
      'No git repository found',
    );
    /* eslint-enable @typescript-eslint/await-thenable */
    expect(discoverProjectSpy).not.toHaveBeenCalled();
  });

  it('shows repository summary before the scope prompt when in a git repository', async () => {
    findGitRootSpy.mockReturnValue({ gitRoot: '/my/project', isGit: true });
    queueMockResponse('project');
    queueMockResponse(null); // user cancels at the hook-type prompt
    try {
      await integrateGit({}, MOCK_AUTH);
    } catch {
      // expected cancellation
    }
    expect(printGitPreflightSummarySpy).toHaveBeenCalledWith('/my/project');
  });

  it('records the husky integration when core.hooksPath points to .husky', async () => {
    mkdirSync(join(TEMP_DIR, '.husky'), { recursive: true });
    findGitRootSpy.mockReturnValue({ gitRoot: TEMP_DIR, isGit: true });
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: '.husky\n',
      stderr: '',
    });
    try {
      await integrateGit({ nonInteractive: true, hook: 'pre-commit' }, MOCK_AUTH);
      const feature = state.integrations.installed[0]?.features[0];
      expect(state.integrations.installed[0]?.integrationId).toBe('husky');
      expect(feature).toMatchObject({
        featureId: 'pre-commit-hook',
        scope: 'project',
        targetRoot: TEMP_DIR,
        dependencies: [],
        subfeatures: [{ featureId: 'pre-commit-secrets', dependencies: [{ id: 'sonar-secrets' }] }],
      });
      expect(
        feature?.resources.some(
          (resource) => resource.id === 'hook-file' && resource.resourceType === 'text-snippet',
        ),
      ).toBe(true);
      expect(state.dependencies.installed).toMatchObject([
        {
          id: 'sonar-secrets',
          dependencyType: 'sonarsource-binary',
        },
      ]);
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('records the pre-commit integration when .pre-commit-config.yaml is present', async () => {
    mkdirSync(TEMP_DIR, { recursive: true });
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      'repos:\n  - repo: local\n    hooks:\n      - id: some-other-hook\n        entry: echo hello\n        language: system\n',
    );
    findGitRootSpy.mockReturnValue({ gitRoot: TEMP_DIR, isGit: true });
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockImplementation((command, args) => {
      if (command === 'git') {
        return Promise.resolve(NO_HOOKS_PATH);
      }
      if (command === 'pre-commit') {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });
    try {
      await integrateGit({ nonInteractive: true, hook: 'pre-commit' }, MOCK_AUTH);
      const feature = state.integrations.installed[0]?.features[0];
      expect(state.integrations.installed[0]?.integrationId).toBe('pre-commit');
      expect(feature).toMatchObject({
        featureId: 'pre-commit-hook',
        scope: 'project',
        targetRoot: TEMP_DIR,
        dependencies: [],
        subfeatures: [{ featureId: 'pre-commit-secrets', dependencies: [{ id: 'sonar-secrets' }] }],
      });
      expect(
        feature?.resources.some(
          (resource) => resource.id === 'hook-config' && resource.resourceType === 'yaml-patch',
        ),
      ).toBe(true);
      expect(feature?.operations.some((operation) => operation.id === 'activate-hook')).toBe(true);
      expect(state.dependencies.installed).toMatchObject([
        {
          id: 'sonar-secrets',
          dependencyType: 'sonarsource-binary',
        },
      ]);
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('records the native-git integration when no husky or pre-commit config is present', async () => {
    mkdirSync(join(TEMP_DIR, '.git', 'hooks'), { recursive: true });
    findGitRootSpy.mockReturnValue({ gitRoot: TEMP_DIR, isGit: true });
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(NO_HOOKS_PATH);
    try {
      await integrateGit({ nonInteractive: true, hook: 'pre-commit' }, MOCK_AUTH);
      expect(existsSync(join(TEMP_DIR, '.git', 'hooks', 'pre-commit'))).toBe(true);
      const feature = state.integrations.installed[0]?.features[0];
      expect(state.integrations.installed[0]?.integrationId).toBe('native-git');
      expect(feature).toMatchObject({
        featureId: 'pre-commit-hook',
        scope: 'project',
        targetRoot: TEMP_DIR,
        dependencies: [],
        subfeatures: [{ featureId: 'pre-commit-secrets', dependencies: [{ id: 'sonar-secrets' }] }],
      });
      expect(
        feature?.resources.some(
          (resource) => resource.id === 'hook-file' && resource.resourceType === 'whole-file',
        ),
      ).toBe(true);
      expect(feature?.operations).toEqual([]);
      expect(state.dependencies.installed).toMatchObject([
        {
          id: 'sonar-secrets',
          dependencyType: 'sonarsource-binary',
        },
      ]);
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('throws CommandFailedError when user cancels at the dependency-risks prompt', async () => {
    mkdirSync(join(TEMP_DIR, '.git', 'hooks'), { recursive: true });
    findGitRootSpy.mockReturnValue({ gitRoot: TEMP_DIR, isGit: true });
    discoverProjectSpy.mockResolvedValue({
      rootDir: TEMP_DIR,
      projectKey: 'my-project',
      isGitRepo: true,
      configSources: [],
    });
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(NO_HOOKS_PATH);
    queueMockResponse('project');
    queueMockResponse(true);
    queueMockResponse(null);
    let caughtError: unknown;
    try {
      await integrateGit({}, MOCK_AUTH);
    } catch (err) {
      caughtError = err;
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
    expect(discoverProjectSpy).toHaveBeenCalledWith(TEMP_DIR, true, { auth: MOCK_AUTH });
    expect(caughtError).toBeInstanceOf(CommandFailedError);
    expect((caughtError as Error).message).toContain('Installation cancelled');
  });
});

describe('integrateGitGlobal', () => {
  let installBinarySpy: ReturnType<typeof spyOn>;
  let resolveBinaryPathSpy: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
  let state: CliState;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    installBinarySpy = spyOn(binaryInstall, 'installBinary').mockResolvedValue({
      binaryPath: '/usr/local/bin/sonar-secrets',
      freshlyInstalled: true,
    });
    resolveBinaryPathSpy = spyOn(binaryInstall, 'resolveBinaryPath').mockReturnValue(null);
    state = getDefaultState('test');
    loadStateSpy = spyOn(stateRepository, 'loadState').mockImplementation(() => state);
    saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setMockUi(false);
    installBinarySpy.mockRestore();
    resolveBinaryPathSpy.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
  });

  it('throws CommandFailedError when the user cancels the global install confirmation', async () => {
    queueMockResponse(null);
    let caughtMessage = '';
    try {
      await integrateGit({ global: true, nonInteractive: false, hook: 'pre-commit' }, MOCK_AUTH);
    } catch (e) {
      caughtMessage = e instanceof Error ? e.message : '';
    }
    expect(caughtMessage).toBe('Installation cancelled');
  });

  it('propagates the error when secrets installation fails after the user confirms', async () => {
    installBinarySpy.mockRejectedValue(new Error('download failed'));
    let caughtMessage = '';
    try {
      await integrateGit({ global: true, nonInteractive: true, hook: 'pre-commit' }, MOCK_AUTH);
    } catch (e) {
      caughtMessage = e instanceof Error ? e.message : '';
    }
    expect(caughtMessage).toBe('download failed');
  });

  it('shows the installed feature in the completion summary when the full global installation succeeds', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    try {
      await integrateGit({ global: true, nonInteractive: true, hook: 'pre-commit' }, MOCK_AUTH);
      const calls = getMockUiCalls();
      const summaryCall = calls.find((c) => c.method === 'phase' && c.args[0] === 'Installed');
      expect(summaryCall).toBeDefined();
      const items = (summaryCall?.args[1] ?? []) as Array<{ text: string }>;
      expect(items.some((item) => item.text === 'pre-commit code scanning hook')).toBe(true);
      expect(state.integrations.installed[0]?.integrationId).toBe('native-git');
    } finally {
      spawnSpy.mockRestore();
      rmSync(join(GLOBAL_HOOKS_DIR, 'pre-commit'), { force: true });
    }
  });

  it('throws CommandFailedError when git config exits with non-zero code', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'permission denied',
    });
    try {
      let caughtError: unknown;
      try {
        await integrateGit({ global: true, nonInteractive: true, hook: 'pre-commit' }, MOCK_AUTH);
      } catch (e) {
        caughtError = e;
      }
      expect(caughtError).toBeInstanceOf(CommandFailedError);
      expect((caughtError as CommandFailedError).message).toContain(
        "'git config --global core.hooksPath' failed",
      );
      expect((caughtError as CommandFailedError).remediationHint).toBe(
        'Ensure git is installed and your global git configuration is writable, then retry.',
      );
    } finally {
      spawnSpy.mockRestore();
      rmSync(join(GLOBAL_HOOKS_DIR, 'pre-commit'), { force: true });
    }
  });

  it('throws CommandFailedError when git is not installed', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockRejectedValue(new Error('ENOENT'));
    try {
      let caughtError: unknown;
      try {
        await integrateGit({ global: true, nonInteractive: true, hook: 'pre-commit' }, MOCK_AUTH);
      } catch (e) {
        caughtError = e;
      }
      expect(caughtError).toBeInstanceOf(CommandFailedError);
      expect((caughtError as CommandFailedError).message).toContain('Failed to run git');
      expect((caughtError as CommandFailedError).message).toContain('ENOENT');
      expect((caughtError as CommandFailedError).remediationHint).toBe(
        'Ensure git is installed and your global git configuration is writable, then retry.',
      );
    } finally {
      spawnSpy.mockRestore();
      rmSync(join(GLOBAL_HOOKS_DIR, 'pre-commit'), { force: true });
    }
  });
});

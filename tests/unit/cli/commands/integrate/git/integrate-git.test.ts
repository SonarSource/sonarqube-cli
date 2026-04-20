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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { InvalidOptionError } from '../../../../../../src/cli/commands/_common/error.js';
import * as secretsInstall from '../../../../../../src/cli/commands/_common/install/secrets';
import {
  detectSonarHookInstallation as detectHookInstallation,
  hasMarker,
  installViaGitHooks,
  integrateGit,
  type IntegrateGitOptions,
  isGitHookType,
  resolveGitHooksDir,
  resolveHookType,
  showInstallationStatus,
  showPostInstallInfo,
} from '../../../../../../src/cli/commands/integrate/git';
import * as huskyModule from '../../../../../../src/cli/commands/integrate/git/git-husky';
import * as preCommitModule from '../../../../../../src/cli/commands/integrate/git/git-precommit-framework';
import { PRE_COMMIT_CONFIG_FILE } from '../../../../../../src/cli/commands/integrate/git/git-precommit-framework';
import { HOOK_MARKER } from '../../../../../../src/cli/commands/integrate/git/git-shell-fragments';
import * as authResolver from '../../../../../../src/lib/auth-resolver';
import { GLOBAL_HOOKS_DIR } from '../../../../../../src/lib/config-constants';
import * as processLib from '../../../../../../src/lib/process.js';
import * as discovery from '../../../../../../src/lib/project-workspace';
import {
  clearMockUiCalls,
  getMockUiCalls,
  queueMockResponse,
  setMockUi,
} from '../../../../../../src/ui';

const TEMP_DIR = join(process.cwd(), 'tests', 'unit', '.integrate-git-tmp');

/** Simulate `git config core.hooksPath` returning "not set" (exit code 1). */
const NO_HOOKS_PATH = { exitCode: 1, stdout: '', stderr: '' };

const MOCK_RESOLVED_AUTH = {
  token: 'tok',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'cloud' as const,
};

describe('isGitHookType', () => {
  it('returns true for valid hook types and false otherwise', () => {
    expect(isGitHookType('pre-commit')).toBe(true);
    expect(isGitHookType('pre-push')).toBe(true);
    expect(isGitHookType('commit-msg')).toBe(false);
    expect(isGitHookType('')).toBe(false);
  });
});

describe('hasMarker', () => {
  it('returns true only when the file exists and contains the marker', () => {
    mkdirSync(TEMP_DIR, { recursive: true });
    const withMarker = join(TEMP_DIR, 'with-marker');
    const withoutMarker = join(TEMP_DIR, 'without-marker');
    writeFileSync(withMarker, `#!/bin/sh\n# ${HOOK_MARKER}\n`);
    writeFileSync(withoutMarker, '#!/bin/sh\necho hello\n');

    expect(hasMarker(withMarker)).toBe(true);
    expect(hasMarker(withoutMarker)).toBe(false);
    expect(hasMarker(join(TEMP_DIR, 'nonexistent'))).toBe(false);

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
    writeFileSync(join(TEMP_DIR, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n# ${HOOK_MARKER}\n`);
    writeFileSync(join(TEMP_DIR, '.git', 'hooks', 'pre-push'), `#!/bin/sh\n# ${HOOK_MARKER}\n`);

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
    writeFileSync(join(TEMP_DIR, '.husky', 'pre-commit'), `#!/bin/sh\n# ${HOOK_MARKER}\n`);
    writeFileSync(join(TEMP_DIR, '.husky', 'pre-push'), `#!/bin/sh\n# ${HOOK_MARKER}\n`);

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

describe('resolveHookType', () => {
  it('returns pre-commit when --hook pre-commit is passed', async () => {
    const result = await resolveHookType({ hook: 'pre-commit' });
    expect(result).toBe('pre-commit');
  });

  it('returns pre-push when --hook pre-push is passed', async () => {
    const result = await resolveHookType({ hook: 'pre-push' });
    expect(result).toBe('pre-push');
  });

  it('defaults to pre-commit when non-interactive and hook is omitted', async () => {
    const result = await resolveHookType({ nonInteractive: true });
    expect(result).toBe('pre-commit');
  });

  it('returns pre-commit when the user selects it from the prompt', async () => {
    setMockUi(true);
    queueMockResponse('pre-commit');
    try {
      const result = await resolveHookType({});
      expect(result).toBe('pre-commit');
    } finally {
      setMockUi(false);
    }
  });

  it('returns pre-push when the user selects it from the prompt', async () => {
    setMockUi(true);
    queueMockResponse('pre-push');
    try {
      const result = await resolveHookType({});
      expect(result).toBe('pre-push');
    } finally {
      setMockUi(false);
    }
  });

  it('throws CommandFailedError when the user cancels the prompt', () => {
    setMockUi(true);
    queueMockResponse(null);
    try {
      expect(resolveHookType({})).rejects.toThrow('Installation cancelled');
    } finally {
      setMockUi(false);
    }
  });
});

describe('showPostInstallInfo', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    setMockUi(false);
  });

  it('prints staged files message for pre-commit', () => {
    showPostInstallInfo('pre-commit');
    const calls = getMockUiCalls();
    expect(
      calls.some((c) => c.method === 'text' && String(c.args[0]).includes('staged files')),
    ).toBe(true);
  });

  it('prints committed files message for pre-push', () => {
    showPostInstallInfo('pre-push');
    const calls = getMockUiCalls();
    expect(
      calls.some((c) => c.method === 'text' && String(c.args[0]).includes('committed files')),
    ).toBe(true);
  });
});

describe('showInstallationStatus', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    setMockUi(false);
  });

  it('prints pre-commit hook active when gitPreCommit is set', async () => {
    mkdirSync(join(TEMP_DIR, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(TEMP_DIR, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n# ${HOOK_MARKER}\n`);
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(NO_HOOKS_PATH);
    try {
      await showInstallationStatus(TEMP_DIR);
      const calls = getMockUiCalls();
      expect(
        calls.some(
          (c) => c.method === 'info' && String(c.args[0]).includes('pre-commit hook active'),
        ),
      ).toBe(true);
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('prints pre-push hook active when gitPrePush is set', async () => {
    mkdirSync(join(TEMP_DIR, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(TEMP_DIR, '.git', 'hooks', 'pre-push'), `#!/bin/sh\n# ${HOOK_MARKER}\n`);
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(NO_HOOKS_PATH);
    try {
      await showInstallationStatus(TEMP_DIR);
      const calls = getMockUiCalls();
      expect(
        calls.some(
          (c) => c.method === 'info' && String(c.args[0]).includes('pre-push hook active'),
        ),
      ).toBe(true);
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('prints pre-commit framework active when preCommitConfig is set', async () => {
    mkdirSync(TEMP_DIR, { recursive: true });
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      'repos:\n  - repo: local\n    hooks:\n      - id: sonar-secrets\n        name: Sonar secrets scan\n        entry: sonar analyze secrets\n        language: system\n',
    );
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(NO_HOOKS_PATH);
    try {
      await showInstallationStatus(TEMP_DIR);
      const calls = getMockUiCalls();
      expect(
        calls.some(
          (c) => c.method === 'info' && String(c.args[0]).includes('pre-commit framework'),
        ),
      ).toBe(true);
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });
});

describe('installViaGitHooks', () => {
  beforeEach(() => setMockUi(true));
  afterEach(() => {
    setMockUi(false);
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it('creates the hook file when none exists', async () => {
    const hooksDir = join(TEMP_DIR, '.git', 'hooks');
    await installViaGitHooks(hooksDir, 'pre-commit');
    expect(existsSync(join(hooksDir, 'pre-commit'))).toBe(true);
    expect(readFileSync(join(hooksDir, 'pre-commit'), 'utf-8')).toContain(HOOK_MARKER);
  });

  it('throws CommandFailedError when a non-sonar hook exists and force is not set', () => {
    const hooksDir = join(TEMP_DIR, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\necho hello\n');
    expect(installViaGitHooks(hooksDir, 'pre-commit')).rejects.toThrow(
      'Refusing to overwrite existing pre-commit hook',
    );
  });

  it('overwrites a non-sonar hook when force=true', async () => {
    const hooksDir = join(TEMP_DIR, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\necho hello\n');
    await installViaGitHooks(hooksDir, 'pre-commit', true);
    expect(readFileSync(join(hooksDir, 'pre-commit'), 'utf-8')).toContain(HOOK_MARKER);
  });

  it('overwrites an existing sonar hook without force', async () => {
    const hooksDir = join(TEMP_DIR, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'pre-push'), `#!/bin/sh\n# ${HOOK_MARKER}\nold content\n`);
    await installViaGitHooks(hooksDir, 'pre-push');
    const content = readFileSync(join(hooksDir, 'pre-push'), 'utf-8');
    expect(content).toContain(HOOK_MARKER);
    expect(content).not.toContain('old content');
  });
});

describe('integrateGit', () => {
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let findGitRootSpy: ReturnType<typeof spyOn>;
  let installSecretsBinarySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    resolveAuthSpy = spyOn(authResolver, 'resolveAuth');
    findGitRootSpy = spyOn(discovery, 'findGitRoot');
    installSecretsBinarySpy = spyOn(secretsInstall, 'installSecretsBinary').mockResolvedValue(
      '/usr/local/bin/sonar-secrets',
    );
  });

  afterEach(() => {
    setMockUi(false);
    resolveAuthSpy.mockRestore();
    findGitRootSpy.mockRestore();
    installSecretsBinarySpy.mockRestore();
  });

  /* eslint-disable @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable */
  it('throws InvalidOptionError when --hook is invalid before git checks', async () => {
    await expect(
      integrateGit({ nonInteractive: true, hook: 'typo' } as unknown as IntegrateGitOptions),
    ).rejects.toBeInstanceOf(InvalidOptionError);
    await expect(
      integrateGit({ nonInteractive: true, hook: 'typo' } as unknown as IntegrateGitOptions),
    ).rejects.toThrow('--hook must be pre-commit or pre-push');
  });

  it('throws InvalidOptionError for invalid --hook on global install before other work', async () => {
    await expect(
      integrateGit({
        global: true,
        nonInteractive: true,
        hook: 'typo',
      } as unknown as IntegrateGitOptions),
    ).rejects.toBeInstanceOf(InvalidOptionError);
    await expect(
      integrateGit({
        global: true,
        nonInteractive: true,
        hook: 'typo',
      } as unknown as IntegrateGitOptions),
    ).rejects.toThrow('--hook must be pre-commit or pre-push');
  });

  it('throws CommandFailedError when not inside a git repository', () => {
    resolveAuthSpy.mockResolvedValue(MOCK_RESOLVED_AUTH);
    findGitRootSpy.mockReturnValue({ gitRoot: '/not-a-repo', isGit: false });
    expect(integrateGit({ nonInteractive: true })).rejects.toThrow('No git repository found');
  });

  it('asks for confirmation showing the repository path when a git repo is found', async () => {
    resolveAuthSpy.mockResolvedValue(MOCK_RESOLVED_AUTH);
    findGitRootSpy.mockReturnValue({ gitRoot: '/my/project', isGit: true });
    queueMockResponse(null); // user cancels at the confirm prompt
    try {
      await integrateGit({});
    } catch {
      // expected cancellation
    }
    expect(
      getMockUiCalls().some(
        (c) =>
          c.method === 'text' &&
          String(c.args[0]).includes('We will install the hook in this repository: /my/project'),
      ),
    ).toBe(true);
  });

  it('calls installViaHusky when core.hooksPath points to .husky', async () => {
    mkdirSync(join(TEMP_DIR, '.husky'), { recursive: true });
    resolveAuthSpy.mockResolvedValue(MOCK_RESOLVED_AUTH);
    findGitRootSpy.mockReturnValue({ gitRoot: TEMP_DIR, isGit: true });
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: '.husky\n',
      stderr: '',
    });
    const huskySpy = spyOn(huskyModule, 'installViaHusky').mockResolvedValue(undefined);
    try {
      await integrateGit({ nonInteractive: true, hook: 'pre-commit' });
      expect(huskySpy).toHaveBeenCalledTimes(1);
    } finally {
      spawnSpy.mockRestore();
      huskySpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('calls installViaPreCommitFramework when .pre-commit-config.yaml is present', async () => {
    mkdirSync(TEMP_DIR, { recursive: true });
    writeFileSync(
      join(TEMP_DIR, PRE_COMMIT_CONFIG_FILE),
      'repos:\n  - repo: local\n    hooks:\n      - id: some-other-hook\n        entry: echo hello\n        language: system\n',
    );
    resolveAuthSpy.mockResolvedValue(MOCK_RESOLVED_AUTH);
    findGitRootSpy.mockReturnValue({ gitRoot: TEMP_DIR, isGit: true });
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(NO_HOOKS_PATH);
    const preCommitSpy = spyOn(preCommitModule, 'installViaPreCommitFramework').mockResolvedValue(
      undefined,
    );
    try {
      await integrateGit({ nonInteractive: true, hook: 'pre-commit' });
      expect(preCommitSpy).toHaveBeenCalledTimes(1);
    } finally {
      spawnSpy.mockRestore();
      preCommitSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('calls installViaGitHooks (native) when no husky or pre-commit config is present', async () => {
    mkdirSync(join(TEMP_DIR, '.git', 'hooks'), { recursive: true });
    resolveAuthSpy.mockResolvedValue(MOCK_RESOLVED_AUTH);
    findGitRootSpy.mockReturnValue({ gitRoot: TEMP_DIR, isGit: true });
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue(NO_HOOKS_PATH);
    try {
      await integrateGit({ nonInteractive: true, hook: 'pre-commit' });
      expect(existsSync(join(TEMP_DIR, '.git', 'hooks', 'pre-commit'))).toBe(true);
    } finally {
      spawnSpy.mockRestore();
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });
});

describe('integrateGitGlobal', () => {
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let installSecretsBinarySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue(MOCK_RESOLVED_AUTH);
    installSecretsBinarySpy = spyOn(secretsInstall, 'installSecretsBinary').mockResolvedValue(
      '/usr/local/bin/sonar-secrets',
    );
  });

  afterEach(() => {
    setMockUi(false);
    resolveAuthSpy.mockRestore();
    installSecretsBinarySpy.mockRestore();
  });

  it('throws CommandFailedError when the user cancels the global install confirmation', async () => {
    queueMockResponse(null);
    let caughtMessage = '';
    try {
      await integrateGit({ global: true, nonInteractive: false, hook: 'pre-commit' });
    } catch (e) {
      caughtMessage = e instanceof Error ? e.message : '';
    }
    expect(caughtMessage).toBe('Installation cancelled');
  });

  it('propagates the error when secrets installation fails after the user confirms', async () => {
    installSecretsBinarySpy.mockRejectedValue(new Error('download failed'));
    let caughtMessage = '';
    try {
      await integrateGit({ global: true, nonInteractive: true, hook: 'pre-commit' });
    } catch (e) {
      caughtMessage = e instanceof Error ? e.message : '';
    }
    expect(caughtMessage).toBe('download failed');
  });

  it('shows success messages when the full global installation succeeds', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    try {
      await integrateGit({ global: true, nonInteractive: true, hook: 'pre-commit' });
      const calls = getMockUiCalls();
      expect(
        calls.some(
          (c) =>
            c.method === 'success' &&
            String(c.args[0]).includes('pre-commit hook installed globally'),
        ),
      ).toBe(true);
      expect(
        calls.some((c) => c.method === 'success' && String(c.args[0]).includes('core.hooksPath')),
      ).toBe(true);
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
      let caughtMessage = '';
      try {
        await integrateGit({ global: true, nonInteractive: true, hook: 'pre-commit' });
      } catch (e) {
        caughtMessage = e instanceof Error ? e.message : '';
      }
      expect(caughtMessage).toContain('git config --global core.hooksPath failed');
    } finally {
      spawnSpy.mockRestore();
      rmSync(join(GLOBAL_HOOKS_DIR, 'pre-commit'), { force: true });
    }
  });

  it('throws CommandFailedError when git is not installed', async () => {
    const spawnSpy = spyOn(processLib, 'spawnProcess').mockRejectedValue(new Error('ENOENT'));
    try {
      let caughtMessage = '';
      try {
        await integrateGit({ global: true, nonInteractive: true, hook: 'pre-commit' });
      } catch (e) {
        caughtMessage = e instanceof Error ? e.message : '';
      }
      expect(caughtMessage).toContain('Failed to run git');
      expect(caughtMessage).toContain('ENOENT');
    } finally {
      spawnSpy.mockRestore();
      rmSync(join(GLOBAL_HOOKS_DIR, 'pre-commit'), { force: true });
    }
  });
});

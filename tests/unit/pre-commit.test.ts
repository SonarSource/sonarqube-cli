// Pre-commit command tests

import { mock, it, expect, describe, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PRE_COMMIT_CONFIG_CONTENT, preCommitInstallCommand, preCommitUninstallCommand } from '../../src/commands/pre-commit.js';
import * as stateManager from '../../src/lib/state-manager.js';
import * as processModule from '../../src/lib/process.js';
import { getDefaultState } from '../../src/lib/state.js';
import { setMockUi, queueMockResponse } from '../../src/ui';

// Mock spawnProcess so pre-commit tests don't require the real binary.
// Git hooksPath queries return exit 1 (not configured) to avoid interactive prompts.
// All other commands (pre-commit install/uninstall/autoupdate/clean) return exit 0.
mock.module('../../src/lib/process.js', () => ({
  spawnProcess: async (cmd: string, args: string[]) => {
    if (cmd === 'git' && args.includes('--get')) {
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    return { exitCode: 0, stdout: 'pre-commit 3.8.0\n', stderr: '' };
  },
}));

describe('PRE_COMMIT_CONFIG_CONTENT', () => {
  it('contains a repos block with SonarSource pre-commit hook', () => {
    expect(PRE_COMMIT_CONFIG_CONTENT).toContain('repos:');
    expect(PRE_COMMIT_CONFIG_CONTENT).toContain('SonarSource/sonar-secrets-pre-commit');
    expect(PRE_COMMIT_CONFIG_CONTENT).toContain('rev:');
    expect(PRE_COMMIT_CONFIG_CONTENT).toContain('id: sonar-secrets');
    expect(PRE_COMMIT_CONFIG_CONTENT).toContain('stages: [pre-commit]');
  });

  it('is valid YAML with correct indentation', () => {
    const lines = PRE_COMMIT_CONFIG_CONTENT.split('\n');
    const LINE_REPOS = 0;
    const LINE_REPO_ENTRY = 1;
    const LINE_REV = 2;
    const LINE_HOOKS = 3;
    const LINE_HOOK_ID = 4;
    const LINE_STAGES = 5;

    expect(lines[LINE_REPOS]).toBe('repos:');
    expect(lines[LINE_REPO_ENTRY].startsWith('-   repo:')).toBe(true);
    expect(lines[LINE_REV].startsWith('    rev:')).toBe(true);
    expect(lines[LINE_HOOKS].startsWith('    hooks:')).toBe(true);
    expect(lines[LINE_HOOK_ID].startsWith('    -   id: sonar-secrets')).toBe(true);
    expect(lines[LINE_STAGES].startsWith('        stages:')).toBe(true);
  });

  it('ends with a newline', () => {
    expect(PRE_COMMIT_CONFIG_CONTENT.endsWith('\n')).toBe(true);
  });
});

describe('pre-commit config file creation', () => {
  it('config content written to disk matches source constant', async () => {
    const testDir = join(tmpdir(), `sonarqube-cli-test-precommit-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    try {
      const configPath = join(testDir, '.pre-commit-config.yaml');

      const fs = await import('node:fs/promises');
      await fs.writeFile(configPath, PRE_COMMIT_CONFIG_CONTENT, 'utf-8');

      expect(existsSync(configPath)).toBe(true);
      const written = readFileSync(configPath, 'utf-8');
      expect(written).toBe(PRE_COMMIT_CONFIG_CONTENT);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe('preCommitUninstallCommand', () => {
  let mockExit: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when not in a git repository', async () => {
    const testDir = join(tmpdir(), `test-precommit-uninstall-nogit-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    try {
      await preCommitUninstallCommand();
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('exits 0 when config file is already removed from git repository', async () => {
    const testDir = join(tmpdir(), `test-precommit-uninstall-git-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    try {
      await preCommitUninstallCommand();
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('removes .pre-commit-config.yaml when it exists', async () => {
    const testDir = join(tmpdir(), `test-precommit-uninstall-rm-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    writeFileSync(join(testDir, '.pre-commit-config.yaml'), PRE_COMMIT_CONFIG_CONTENT, 'utf-8');
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    try {
      await preCommitUninstallCommand();
      expect(mockExit).toHaveBeenCalledWith(0);
      expect(existsSync(join(testDir, '.pre-commit-config.yaml'))).toBe(false);
    } finally {
      cwdSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe('preCommitInstallCommand', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when not in a git repository', async () => {
    const testDir = join(tmpdir(), `test-precommit-install-nogit-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('exits 0 when pre-commit installs successfully in git repository', async () => {
    const testDir = join(tmpdir(), `test-precommit-install-success-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('skips .pre-commit-config.yaml creation when file already exists', async () => {
    const testDir = join(tmpdir(), `test-precommit-config-exists-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    writeFileSync(join(testDir, '.pre-commit-config.yaml'), 'existing content', 'utf-8');
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    try {
      await preCommitInstallCommand();
      // File should still contain original content (not overwritten)
      const content = readFileSync(join(testDir, '.pre-commit-config.yaml'), 'utf-8');
      expect(content).toBe('existing content');
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('warns but continues when autoupdate fails', async () => {
    const testDir = join(tmpdir(), `test-precommit-autoupdate-fail-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    // Override spawnProcess: autoupdate returns non-zero, other commands succeed
    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'pre-commit' && args.includes('autoupdate')) {
          return { exitCode: 1, stdout: '', stderr: 'autoupdate error' };
        }
        if (cmd === 'git' && args.includes('--get')) {
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: 'pre-commit 3.8.0\n', stderr: '' };
      }
    );

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when pre-commit install command fails', async () => {
    const testDir = join(tmpdir(), `test-precommit-install-fail-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'pre-commit' && args.includes('install')) {
          return { exitCode: 1, stdout: '', stderr: 'install failed' };
        }
        if (cmd === 'git' && args.includes('--get')) {
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: 'pre-commit 3.8.0\n', stderr: '' };
      }
    );

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ─── handleCustomHooksPath ────────────────────────────────────────────────────

describe('preCommitInstallCommand: custom git hooksPath', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('unsets core.hooksPath and continues when user confirms', async () => {
    const testDir = join(tmpdir(), `test-precommit-hookspath-confirm-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('--local') && args.includes('--get')) {
          return { exitCode: 0, stdout: '/custom/hooks\n', stderr: '' };
        }
        return { exitCode: 0, stdout: 'pre-commit 3.8.0\n', stderr: '' };
      }
    );

    // User confirms unsetting hooksPath
    queueMockResponse(true);

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('exits 0 when user declines to unset core.hooksPath', async () => {
    const testDir = join(tmpdir(), `test-precommit-hookspath-cancel-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('--local') && args.includes('--get')) {
          return { exitCode: 0, stdout: '/custom/hooks\n', stderr: '' };
        }
        return { exitCode: 0, stdout: 'pre-commit 3.8.0\n', stderr: '' };
      }
    );

    // User declines
    queueMockResponse(false);

    try {
      await preCommitInstallCommand();
      // process.exit(0) called in handleCustomHooksPath when user declines
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ─── preCommitUninstallCommand: additional paths ──────────────────────────────

describe('preCommitUninstallCommand: uninstall failure', () => {
  let mockExit: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
    setMockUi(false);
  });

  it('warns when pre-commit uninstall returns non-zero exit code', async () => {
    const testDir = join(tmpdir(), `test-precommit-uninstall-fail-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'pre-commit' && args.includes('uninstall')) {
          return { exitCode: 1, stdout: '', stderr: 'error' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    );

    try {
      await preCommitUninstallCommand();
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('warns when pre-commit binary is not found during uninstall', async () => {
    const testDir = join(tmpdir(), `test-precommit-uninstall-notfound-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string) => {
        if (cmd === 'pre-commit') throw new Error('command not found');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    );

    try {
      await preCommitUninstallCommand();
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ─── ensurePreCommitInstalled ──────────────────────────────────────────────────

describe('preCommitInstallCommand: pre-commit not installed', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('installs via brew when pre-commit throws on version check', async () => {
    const testDir = join(tmpdir(), `test-precommit-notinstalled-brew-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    let preCommitVersionCalls = 0;
    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'pre-commit' && args.includes('--version')) {
          preCommitVersionCalls++;
          if (preCommitVersionCalls === 1) {
            throw new Error('command not found: pre-commit');
          }
          return { exitCode: 0, stdout: 'pre-commit 3.8.0\n', stderr: '' };
        }
        if (cmd === 'brew') return { exitCode: 0, stdout: 'Homebrew 4.0\n', stderr: '' };
        if (cmd === 'git' && args.includes('--get')) return { exitCode: 1, stdout: '', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    );

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('installs via pip3 when brew throws on version check', async () => {
    const testDir = join(tmpdir(), `test-precommit-pip3-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    let preCommitVersionCalls = 0;
    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'pre-commit' && args.includes('--version')) {
          preCommitVersionCalls++;
          if (preCommitVersionCalls === 1) {
            return { exitCode: 1, stdout: '', stderr: '' };
          }
          return { exitCode: 0, stdout: 'pre-commit 3.8.0\n', stderr: '' };
        }
        if (cmd === 'brew') throw new Error('command not found: brew');
        if (cmd === 'pip3') return { exitCode: 0, stdout: 'pip 23.0\n', stderr: '' };
        if (cmd === 'git' && args.includes('--get')) return { exitCode: 1, stdout: '', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    );

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when installation verification always fails', async () => {
    const testDir = join(tmpdir(), `test-precommit-verifyfail-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'pre-commit' && args.includes('--version')) {
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        if (cmd === 'brew') return { exitCode: 0, stdout: 'Homebrew 4.0\n', stderr: '' };
        if (cmd === 'git' && args.includes('--get')) return { exitCode: 1, stdout: '', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    );

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ─── checkGitHooksPath: global and system scope ────────────────────────────────

describe('preCommitInstallCommand: global and system hooksPath', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('detects and unsets global hooksPath when user confirms', async () => {
    const testDir = join(tmpdir(), `test-precommit-global-hooks-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('--local') && args.includes('--get')) {
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        if (cmd === 'git' && args.includes('--global') && args.includes('--get')) {
          return { exitCode: 0, stdout: '/global/hooks\n', stderr: '' };
        }
        if (cmd === 'git' && args.includes('--get')) {
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: 'pre-commit 3.8.0\n', stderr: '' };
      }
    );

    queueMockResponse(true);

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('detects and unsets system hooksPath when user confirms', async () => {
    const testDir = join(tmpdir(), `test-precommit-system-hooks-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('--local') && args.includes('--get')) {
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        if (cmd === 'git' && args.includes('--global') && args.includes('--get')) {
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        if (cmd === 'git' && args.includes('--system') && args.includes('--get')) {
          return { exitCode: 0, stdout: '/system/hooks\n', stderr: '' };
        }
        if (cmd === 'git' && args.includes('--get')) {
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: 'pre-commit 3.8.0\n', stderr: '' };
      }
    );

    queueMockResponse(true);

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('exits 0 when git config throws exception in checkGitHooksPath', async () => {
    const testDir = join(tmpdir(), `test-precommit-gitthrows-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('--get')) {
          throw new Error('git config unavailable');
        }
        return { exitCode: 0, stdout: 'pre-commit 3.8.0\n', stderr: '' };
      }
    );

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ─── unsetGitHooksPath failure ──────────────────────────────────────────────────

describe('preCommitInstallCommand: unsetGitHooksPath fails', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when git config --unset-all fails', async () => {
    const testDir = join(tmpdir(), `test-precommit-unset-fail-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('--local') && args.includes('--get')) {
          return { exitCode: 0, stdout: '/custom/hooks\n', stderr: '' };
        }
        if (cmd === 'git' && args.includes('--unset-all')) {
          return { exitCode: 1, stdout: '', stderr: 'cannot unset' };
        }
        if (cmd === 'git' && args.includes('--get')) {
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: 'pre-commit 3.8.0\n', stderr: '' };
      }
    );

    queueMockResponse(true);

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ─── recordPreCommitInState failure ───────────────────────────────────────────

describe('preCommitInstallCommand: recordPreCommitInState failure', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
  });

  afterEach(() => {
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    setMockUi(false);
  });

  it('exits 0 even when saveState throws during state recording', async () => {
    const testDir = join(tmpdir(), `test-precommit-savestate-fail-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    const saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {
      throw new Error('disk full');
    });

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      saveStateSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ─── installPreCommit: install command fails ───────────────────────────────────

describe('preCommitInstallCommand: install command fails', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMockUi(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(getDefaultState('test'));
    saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    loadStateSpy.mockRestore();
    saveStateSpy.mockRestore();
    setMockUi(false);
  });

  it('exits 1 when brew install command returns non-zero', async () => {
    const testDir = join(tmpdir(), `test-precommit-brewfail-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'pre-commit' && args.includes('--version')) {
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        if (cmd === 'brew' && args.includes('--version')) {
          return { exitCode: 0, stdout: 'Homebrew 4.0\n', stderr: '' };
        }
        if (cmd === 'brew' && args.includes('install')) {
          return { exitCode: 1, stdout: '', stderr: 'install failed' };
        }
        if (cmd === 'git' && args.includes('--get')) return { exitCode: 1, stdout: '', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    );

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when no package manager available on macOS', async () => {
    const testDir = join(tmpdir(), `test-precommit-nopkgmgr-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'pre-commit' && args.includes('--version')) {
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        // brew, pip3, and pip all unavailable
        if (cmd === 'brew' || cmd === 'pip3' || cmd === 'pip') {
          return { exitCode: 1, stdout: '', stderr: '' };
        }
        if (cmd === 'git' && args.includes('--get')) return { exitCode: 1, stdout: '', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    );

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('installs via pip when pip3 unavailable but pip exists', async () => {
    const testDir = join(tmpdir(), `test-precommit-pip-${Date.now()}`);
    mkdirSync(join(testDir, '.git'), { recursive: true });
    const cwdSpy = spyOn(process, 'cwd').mockReturnValue(testDir);

    let preCommitVersionCalls = 0;
    const spawnSpy = spyOn(processModule, 'spawnProcess').mockImplementation(
      async (cmd: string, args: string[]) => {
        if (cmd === 'pre-commit' && args.includes('--version')) {
          preCommitVersionCalls++;
          if (preCommitVersionCalls === 1) return { exitCode: 1, stdout: '', stderr: '' };
          return { exitCode: 0, stdout: 'pre-commit 3.8.0\n', stderr: '' };
        }
        if (cmd === 'brew') return { exitCode: 1, stdout: '', stderr: '' };
        if (cmd === 'pip3') return { exitCode: 1, stdout: '', stderr: '' };
        if (cmd === 'pip') return { exitCode: 0, stdout: 'pip 23.0\n', stderr: '' };
        if (cmd === 'git' && args.includes('--get')) return { exitCode: 1, stdout: '', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    );

    try {
      await preCommitInstallCommand();
      expect(mockExit).toHaveBeenCalledWith(0);
    } finally {
      cwdSpy.mockRestore();
      spawnSpy.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

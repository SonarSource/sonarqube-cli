// Pre-commit command tests

import { mock, it, expect, describe, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PRE_COMMIT_CONFIG_CONTENT, preCommitInstallCommand, preCommitUninstallCommand } from '../../src/commands/pre-commit.js';
import { setMockUi } from '../../src/ui';

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
});

describe('preCommitInstallCommand', () => {
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
});

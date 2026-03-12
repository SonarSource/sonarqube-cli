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

// Integrate command - install git hooks for secrets scanning

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_HOOKS_DIR } from '../../../../lib/config-constants';
import logger from '../../../../lib/logger';
import { resolveAuth } from '../../../../lib/auth-resolver';
import { discoverProject } from '../../_common/discovery';
import { CommandFailedError, InvalidOptionError } from '../../_common/error';
import { performSecretInstall } from '../../install/secrets';
import { spawnProcess } from '../../../../lib/process';
import {
  blank,
  confirmPrompt,
  error,
  info,
  intro,
  note,
  selectPrompt,
  success,
  text,
  warn,
} from '../../../../ui';
import { HOOK_MARKER, getHookScript } from './git-shell-fragments';
import { installViaHusky } from './git-husky';
import {
  PRE_COMMIT_CONFIG_FILE,
  ensurePreCommitConfig,
  hasSonarHookInPreCommitConfig,
  runPreCommitInstall,
} from './git-precommit-framework';

export type GitHookType = 'pre-commit' | 'pre-push';

function isGitHookType(s: string): s is GitHookType {
  return s === 'pre-commit' || s === 'pre-push';
}

export interface IntegrateGitOptions {
  hook?: GitHookType;
  force?: boolean;
  nonInteractive?: boolean;
  global?: boolean;
}

// ---------------------------------------------------------------------------
// Hook detection
// ---------------------------------------------------------------------------

function hasMarker(filePath: string): boolean {
  return existsSync(filePath) && readFileSync(filePath, 'utf-8').includes(HOOK_MARKER);
}

interface HookInstallation {
  preCommitConfig: boolean;
  huskyPreCommit: boolean;
  huskyPrePush: boolean;
  gitPreCommit: boolean;
  gitPrePush: boolean;
}

async function resolveGitHooksDir(root: string): Promise<string> {
  const dotGit = join(root, '.git');
  try {
    // Standard repo: .git is a directory — hooks live directly inside it, no subprocess needed
    if (statSync(dotGit).isDirectory()) {
      return join(dotGit, 'hooks');
    }
  } catch {
    // .git doesn't exist; fall through to git rev-parse
  }
  // Worktree or submodule: .git is a file pointer — ask git for the real hooks path
  const result = await spawnProcess('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root });
  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n');
    const errorMessage = `Could not resolve git hooks directory (exit code ${result.exitCode}) ${detail}`;
    error(errorMessage);
    throw new CommandFailedError(errorMessage);
  }
  const resolved = result.stdout.trim();
  return resolved.startsWith('/') ? resolved : join(root, resolved);
}

async function detectHookInstallation(root: string): Promise<HookInstallation> {
  let hooksDir: string;
  try {
    hooksDir = await resolveGitHooksDir(root);
  } catch {
    hooksDir = join(root, '.git', 'hooks');
  }
  return {
    preCommitConfig: hasSonarHookInPreCommitConfig(root),
    huskyPreCommit: hasMarker(join(root, '.husky', 'pre-commit')),
    huskyPrePush: hasMarker(join(root, '.husky', 'pre-push')),
    gitPreCommit: hasMarker(join(hooksDir, 'pre-commit')),
    gitPrePush: hasMarker(join(hooksDir, 'pre-push')),
  };
}

// ---------------------------------------------------------------------------
// Shared interaction helpers
// ---------------------------------------------------------------------------

async function resolveHookType(
  options: IntegrateGitOptions,
  huskyHints?: { preCommit: boolean; prePush: boolean },
): Promise<GitHookType> {
  if (options.nonInteractive || options.hook !== undefined) {
    const rawHook = options.hook ?? 'pre-commit';
    if (!isGitHookType(rawHook)) {
      throw new InvalidOptionError('--hook must be pre-commit or pre-push');
    }
    return rawHook;
  }
  const choice = await selectPrompt<GitHookType>('Install hook for pre-commit or pre-push?', [
    {
      value: 'pre-commit' as const,
      label: `pre-commit (scan staged files)${huskyHints?.preCommit ? ' — Husky detected' : ''}`,
    },
    {
      value: 'pre-push' as const,
      label: `pre-push (scan files in pushed commits)${huskyHints?.prePush ? ' — Husky detected' : ''}`,
    },
  ]);
  if (choice === null) {
    error('Installation cancelled');
    throw new CommandFailedError('Installation cancelled');
  }
  return choice;
}

async function ensureSonarSecrets(): Promise<void> {
  try {
    await performSecretInstall({});
  } catch (err) {
    if ((err as Error).message !== 'Installation skipped - already up to date') {
      throw err;
    }
  }
  info('sonar-secrets is installed');
  blank();
}

function showPostInstallInfo(hook: GitHookType): void {
  blank();
  text(
    hook === 'pre-commit'
      ? 'The hook will scan staged files for secrets before each commit.'
      : 'The hook will scan committed files for secrets before each push.',
  );
  text('Ensure "sonar" is on your PATH when you commit or push.');
  blank();
}

async function showInstallationStatus(root: string): Promise<void> {
  const installed = await detectHookInstallation(root);
  if (installed.preCommitConfig) {
    info(`Status: hook active via pre-commit framework (${PRE_COMMIT_CONFIG_FILE})`);
  } else if (installed.huskyPreCommit) {
    info('Status: pre-commit hook active (.husky/pre-commit)');
  } else if (installed.huskyPrePush) {
    info('Status: pre-push hook active (.husky/pre-push)');
  } else if (installed.gitPreCommit) {
    info('Status: pre-commit hook active (.git/hooks/pre-commit)');
  } else if (installed.gitPrePush) {
    info('Status: pre-push hook active (.git/hooks/pre-push)');
  }
  blank();
}

// ---------------------------------------------------------------------------
// Install strategies
// ---------------------------------------------------------------------------

async function installViaPreCommitFramework(root: string, hook: GitHookType): Promise<void> {
  ensurePreCommitConfig(root, hook);
  try {
    await runPreCommitInstall(root, hook);
  } catch {
    const errorMessage = `Updated ${PRE_COMMIT_CONFIG_FILE} but pre-commit commands failed. Install the pre-commit framework (e.g. pip install pre-commit) and run: pre-commit uninstall && pre-commit clean && pre-commit install${hook === 'pre-push' ? ' && pre-commit install --hook-type pre-push' : ''}`;
    error(errorMessage);
    throw new CommandFailedError(errorMessage);
  }
  success(`${hook} hook installed (pre-commit framework: added to ${PRE_COMMIT_CONFIG_FILE}).`);
}

async function installViaGitHooks(root: string, hook: GitHookType, force?: boolean): Promise<void> {
  const fs = await import('node:fs/promises');
  const hooksDir = await resolveGitHooksDir(root);
  if (!existsSync(hooksDir)) {
    error(`Git hooks directory not found: ${hooksDir}`);
    throw new CommandFailedError(`Git hooks directory not found: ${hooksDir}`);
  }
  const hookPath = join(hooksDir, hook);
  if (existsSync(hookPath)) {
    const existing = await fs.readFile(hookPath, 'utf-8');
    if (!existing.includes(HOOK_MARKER) && !force) {
      warn(`A different ${hook} hook already exists.`);
      text('  Use --force to replace it, or add the secrets check manually.');
      throw new CommandFailedError(
        `Refusing to overwrite existing ${hook} hook. Use --force to replace.`,
      );
    }
  }
  await fs.writeFile(hookPath, getHookScript(hook), { mode: 0o755 });
  success(`${hook} hook installed at ${hookPath}`);
}

// ---------------------------------------------------------------------------
// Public command handlers
// ---------------------------------------------------------------------------

async function integrateGitGlobal(options: IntegrateGitOptions): Promise<void> {
  warn('Global hook installation');
  text('  Git prioritizes local repository settings over global ones.');
  text('  If a project uses Husky or has a local core.hooksPath set,');
  text('  this global hook will NOT run in that project.');
  blank();
  text('  To enable the global hook in such a project, unset its local path:');
  text('    git config --unset core.hooksPath');
  blank();
  text('  This will set git config --global core.hooksPath to:');
  text(`  ${GLOBAL_HOOKS_DIR}`);
  blank();

  if (!options.nonInteractive) {
    const confirmed = await confirmPrompt('Proceed with global installation?');
    if (confirmed === false) {
      text('Cancelled');
      return;
    }
    if (confirmed === null) {
      error('Installation cancelled');
      throw new CommandFailedError('Installation cancelled');
    }
  }
  blank();

  const hook = await resolveHookType(options);
  text(`Hook: ${hook}`);
  blank();

  await ensureSonarSecrets();

  mkdirSync(GLOBAL_HOOKS_DIR, { recursive: true });
  const hookPath = join(GLOBAL_HOOKS_DIR, hook);
  const fs = await import('node:fs/promises');
  if (existsSync(hookPath)) {
    const existing = await fs.readFile(hookPath, 'utf-8');
    if (!existing.includes(HOOK_MARKER) && !options.force) {
      warn(`A different ${hook} hook already exists at ${hookPath}.`);
      text('  Use --force to replace it.');
      throw new CommandFailedError(
        `Refusing to overwrite existing ${hook} hook. Use --force to replace.`,
      );
    }
  }

  await fs.writeFile(hookPath, getHookScript(hook), { mode: 0o755 });

  const gitResult = await spawnProcess('git', [
    'config',
    '--global',
    'core.hooksPath',
    GLOBAL_HOOKS_DIR,
  ]);
  if (gitResult.exitCode !== 0) {
    const detail = [gitResult.stderr, gitResult.stdout].filter(Boolean).join('\n');
    const msg = `git config --global core.hooksPath failed (exit code ${gitResult.exitCode}): ${detail}`;
    error(msg);
    logger.error(msg);
    throw new CommandFailedError(msg);
  }

  success(`${hook} hook installed globally at ${hookPath}`);
  success(`git config --global core.hooksPath set to: ${GLOBAL_HOOKS_DIR}`);
  showPostInstallInfo(hook);
  note('Run: sonar integrate git test', 'Verify the hook works');
}

export async function integrateGit(options: IntegrateGitOptions): Promise<void> {
  intro('SonarQube Git integration (secrets scanning)');
  blank();

  try {
    await resolveAuth({});
  } catch {
    error('Not authenticated. Please run: sonar auth login');
    throw new CommandFailedError('Not authenticated. Please run: sonar auth login');
  }

  if (options.global) {
    return integrateGitGlobal(options);
  }

  const projectInfo = await discoverProject(process.cwd());
  if (!projectInfo.isGitRepo) {
    const errorMessage =
      'No git repository found. Please run this command from inside a git repository, or use --global to install a global hook.';
    error(errorMessage);
    throw new CommandFailedError(errorMessage);
  }

  text(`We will install the hook in this repository: ${projectInfo.root}`);
  blank();

  if (!options.nonInteractive) {
    const confirmed = await confirmPrompt('Install here?');
    if (confirmed === false) {
      text('Cancelled');
      return;
    }
    if (confirmed === null) {
      error('Installation cancelled');
      throw new CommandFailedError('Installation cancelled');
    }
  }
  blank();

  const huskyPreCommitPath = join(projectInfo.root, '.husky', 'pre-commit');
  const huskyPrePushPath = join(projectInfo.root, '.husky', 'pre-push');
  const huskyPreCommitExists = existsSync(huskyPreCommitPath);
  const huskyPrePushExists = existsSync(huskyPrePushPath);

  const hook = await resolveHookType(options, {
    preCommit: huskyPreCommitExists,
    prePush: huskyPrePushExists,
  });
  text(`Hook: ${hook}`);
  blank();

  await ensureSonarSecrets();

  const huskyHookPath = hook === 'pre-commit' ? huskyPreCommitPath : huskyPrePushPath;
  const huskyHookExists = hook === 'pre-commit' ? huskyPreCommitExists : huskyPrePushExists;
  const usePreCommitConfig = existsSync(join(projectInfo.root, PRE_COMMIT_CONFIG_FILE));
  const useHusky = !usePreCommitConfig && huskyHookExists;

  if (usePreCommitConfig) {
    await installViaPreCommitFramework(projectInfo.root, hook);
  } else if (useHusky) {
    await installViaHusky(huskyHookPath, hook);
  } else {
    await installViaGitHooks(projectInfo.root, hook, options.force);
  }

  showPostInstallInfo(hook);
  await showInstallationStatus(projectInfo.root);
  note('Run: sonar integrate git test', 'Verify the hook works');
}

// ---------------------------------------------------------------------------
// Test command
// ---------------------------------------------------------------------------

/** Fake SonarQube token used only by the test command to verify the hook blocks the commit. Not a real secret. */
const TEST_SECRET_CONTENT = `const API_KEY = "${'sqp' + '_' + '1aa323ae0689cd4a1abd062a2ad0a224ae8a1d13'}";`;

const TEST_FILE_NAME = 'secrets-test.js';

/**
 * Run an automated test: create a file with a fake secret, attempt commit, expect hook to block it.
 */
export async function integrateGitTest(): Promise<void> {
  intro('Test secrets hook');
  blank();

  const projectInfo = await discoverProject(process.cwd());
  if (!projectInfo.isGitRepo) {
    const errorMessage =
      'No git repository found. Run this command from inside a git repository, or use --global to install a global hook.';
    error(errorMessage);
    throw new CommandFailedError(errorMessage);
  }

  const installed = await detectHookInstallation(projectInfo.root);
  if (!installed.preCommitConfig && !installed.huskyPreCommit && !installed.gitPreCommit) {
    const errorMessage = 'Pre-commit hook not found. Install with: sonar integrate git';
    error(errorMessage);
    throw new CommandFailedError(errorMessage);
  }

  const testFilePath = join(projectInfo.root, TEST_FILE_NAME);

  try {
    writeFileSync(testFilePath, TEST_SECRET_CONTENT, 'utf-8');
  } catch (err) {
    const errorMessage = `Could not create test file ${TEST_FILE_NAME}: ${(err as Error).message}`;
    error(errorMessage);
    throw new CommandFailedError(errorMessage);
  }

  const cleanup = async (): Promise<void> => {
    try {
      await spawnProcess('git', ['reset', 'HEAD', '--', TEST_FILE_NAME], {
        cwd: projectInfo.root,
      });
    } catch {
      // ignore
    }
    try {
      if (existsSync(testFilePath)) {
        unlinkSync(testFilePath);
      }
    } catch {
      // ignore
    }
  };

  try {
    await spawnProcess('git', ['add', TEST_FILE_NAME], { cwd: projectInfo.root });

    text('Running: git commit (hook output will appear below)...');
    blank();

    const commitResult = await spawnProcess('git', ['commit', '-m', 'Test: verify secrets hook'], {
      cwd: projectInfo.root,
      stdout: 'inherit',
      stderr: 'inherit',
    });

    blank();

    if (commitResult.exitCode === 0) {
      // The commit went through — undo it so the repo is left in a clean state
      try {
        await spawnProcess('git', ['reset', '--mixed', 'HEAD^'], { cwd: projectInfo.root });
      } catch {
        // ignore reset failure; cleanup() will still try to unlink
      }
      await cleanup();
      const errorMessage =
        'Hook test failed: the commit succeeded but the hook should have blocked it (file contained a fake secret).';
      error(errorMessage);
      throw new CommandFailedError(errorMessage);
    }

    success('Hook test passed: the commit was blocked as expected.');
  } finally {
    await cleanup();
  }
}

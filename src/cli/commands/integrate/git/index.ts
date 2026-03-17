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

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { platform } from 'node:os';
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
  hasSonarHookInPreCommitConfig,
  installViaPreCommitFramework,
} from './git-precommit-framework';

const toForwardSlash = (p: string) => p.replaceAll('\\', '/');

export type GitHookType = 'pre-commit' | 'pre-push';

export function isGitHookType(s: string): s is GitHookType {
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

export function hasMarker(filePath: string): boolean {
  return existsSync(filePath) && readFileSync(filePath, 'utf-8').includes(HOOK_MARKER);
}

interface HookInstallation {
  preCommitConfig: boolean;
  huskyPreCommit: boolean;
  huskyPrePush: boolean;
  gitPreCommit: boolean;
  gitPrePush: boolean;
  hooksDir: string;
}

export async function resolveGitHooksDir(root: string): Promise<string> {
  // core.hooksPath takes precedence over everything — it's what git actually uses to find hooks.
  // Husky sets this to .husky; other tools (e.g. lefthook) may point elsewhere.
  let configResult;
  try {
    configResult = await spawnProcess('git', ['config', 'core.hooksPath'], { cwd: root });
  } catch {
    configResult = null;
  }
  if (configResult?.exitCode === 0) {
    const configured = configResult.stdout.trim();
    if (configured) {
      return isAbsolute(configured) ? configured : join(root, configured);
    }
  }

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
  let result;
  try {
    result = await spawnProcess('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root });
  } catch {
    const errorMessage = 'git is not installed or not on PATH';
    error(errorMessage);
    throw new CommandFailedError(errorMessage);
  }
  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n');
    const errorMessage = `Could not resolve git hooks directory (exit code ${result.exitCode}) ${detail}`;
    error(errorMessage);
    throw new CommandFailedError(errorMessage);
  }
  const resolved = result.stdout.trim();
  return isAbsolute(resolved) ? resolved : join(root, resolved);
}

export async function detectSonarHookInstallation(root: string): Promise<HookInstallation> {
  let hooksDir: string;
  try {
    hooksDir = await resolveGitHooksDir(root);
  } catch {
    hooksDir = join(root, '.git', 'hooks');
  }
  const isHusky = toForwardSlash(hooksDir).startsWith(toForwardSlash(join(root, '.husky')));
  return {
    preCommitConfig: hasSonarHookInPreCommitConfig(root),
    huskyPreCommit: isHusky && hasMarker(join(hooksDir, 'pre-commit')),
    huskyPrePush: isHusky && hasMarker(join(hooksDir, 'pre-push')),
    gitPreCommit: !isHusky && hasMarker(join(hooksDir, 'pre-commit')),
    gitPrePush: !isHusky && hasMarker(join(hooksDir, 'pre-push')),
    hooksDir,
  };
}

// ---------------------------------------------------------------------------
// Shared interaction helpers
// ---------------------------------------------------------------------------

export async function resolveHookType(options: IntegrateGitOptions): Promise<GitHookType> {
  if (options.nonInteractive || options.hook !== undefined) {
    const rawHook = options.hook ?? 'pre-commit';
    if (!isGitHookType(rawHook)) {
      throw new InvalidOptionError('--hook must be pre-commit or pre-push');
    }
    return rawHook;
  }
  const choice = await selectPrompt<GitHookType>(
    'Would you like to install the pre-commit or pre-push hook?',
    [
      {
        value: 'pre-commit' as const,
        label: 'pre-commit (scan staged files)',
      },
      {
        value: 'pre-push' as const,
        label: 'pre-push (scan files in unpushed commits)',
      },
    ],
  );
  if (choice === null) {
    error('Installation cancelled');
    throw new CommandFailedError('Installation cancelled');
  }
  return choice;
}

async function ensureSonarSecrets(): Promise<void> {
  await performSecretInstall({});
  info('sonar-secrets is installed');
  blank();
}

export function showPostInstallInfo(hook: GitHookType): void {
  blank();
  text(
    hook === 'pre-commit'
      ? 'The hook will scan staged files for secrets before each commit.'
      : 'The hook will scan committed files for secrets before each push.',
  );
  text('Ensure "sonar" is on your PATH when you commit or push.');
  blank();
}

const VERIFY_FILE_NAME = 'sonar-hook-verify.js';
const VERIFY_SECRET_CONTENT = `const API_KEY = "sqp_b4556a16fa2d28519d2451a911d2e073024010bc";`;

export function showVerificationGuide(hook: GitHookType): void {
  blank();
  note(
    [
      'To verify the hook works:',
      `  1. Create a file named ${VERIFY_FILE_NAME} containing:`,
      `       ${VERIFY_SECRET_CONTENT}`,
      hook === 'pre-commit'
        ? `  2. Stage it:      git add ${VERIFY_FILE_NAME}`
        : `  2. Commit it:     git add ${VERIFY_FILE_NAME} && git commit -m "verify"`,
      hook === 'pre-commit'
        ? '  3. Try to commit: git commit -m "verify"'
        : '  3. Try to push:   git push',
      '  4. The hook should block the operation and report the secret.',
      `  5. Delete the file: ${platform() === 'win32' ? 'del' : 'rm'} ${VERIFY_FILE_NAME}`,
    ].join('\n'),
    'Verify the hook works',
  );
}

export async function showInstallationStatus(root: string): Promise<void> {
  const installed = await detectSonarHookInstallation(root);
  if (installed.preCommitConfig) {
    info(`Status: hook active via pre-commit framework (${PRE_COMMIT_CONFIG_FILE})`);
  } else if (installed.huskyPreCommit || installed.gitPreCommit) {
    info(`Status: pre-commit hook active (${join(installed.hooksDir, 'pre-commit')})`);
  } else if (installed.huskyPrePush || installed.gitPrePush) {
    info(`Status: pre-push hook active (${join(installed.hooksDir, 'pre-push')})`);
  }
  blank();
}

// ---------------------------------------------------------------------------
// Install strategies
// ---------------------------------------------------------------------------

export async function installViaGitHooks(
  hooksDir: string,
  hook: GitHookType,
  force?: boolean,
): Promise<void> {
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, hook);
  const fs = await import('node:fs/promises');
  if (existsSync(hookPath)) {
    const existing = await fs.readFile(hookPath, 'utf-8');
    if (!existing.includes(HOOK_MARKER) && !force) {
      warn(`A different ${hook} hook already exists at ${hookPath}.`);
      text('  Use --force to replace it, or add the secrets check manually.');
      throw new CommandFailedError(
        `Refusing to overwrite existing ${hook} hook at ${hookPath}. Use --force to replace.`,
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
  text('  If a project has a local core.hooksPath set,');
  text('  this global hook will NOT run in that project.');
  blank();
  text('  To enable the global hook in such a project, you will need to unset its local path:');
  text('    git config --unset core.hooksPath');
  blank();
  text('  This will set git config --global core.hooksPath to:');
  text(`  ${GLOBAL_HOOKS_DIR}`);
  blank();

  if (!options.nonInteractive) {
    const confirmed = await confirmPrompt('Proceed with global installation?');
    if (confirmed === false || confirmed === null) {
      error('Installation cancelled');
      return;
    }
  }
  blank();

  const hook = await resolveHookType(options);
  text(`Hook: ${hook}`);
  blank();

  await ensureSonarSecrets();

  await installViaGitHooks(GLOBAL_HOOKS_DIR, hook, options.force);

  let gitResult;
  try {
    gitResult = await spawnProcess('git', [
      'config',
      '--global',
      'core.hooksPath',
      toForwardSlash(GLOBAL_HOOKS_DIR),
    ]);
  } catch {
    const msg = 'git is not installed or not on PATH';
    error(msg);
    throw new CommandFailedError(msg);
  }
  if (gitResult.exitCode !== 0) {
    const detail = [gitResult.stderr, gitResult.stdout].filter(Boolean).join('\n');
    const msg = `git config --global core.hooksPath failed (exit code ${gitResult.exitCode}): ${detail}`;
    error(msg);
    logger.error(msg);
    throw new CommandFailedError(msg);
  }

  success(`${hook} hook installed globally at ${join(GLOBAL_HOOKS_DIR, hook)}`);
  success(`git config --global core.hooksPath set to: ${GLOBAL_HOOKS_DIR}`);
  showPostInstallInfo(hook);
  showVerificationGuide(hook);
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

  text(`We will install the hook in this repository: ${projectInfo.rootDir}`);
  blank();

  if (!options.nonInteractive) {
    const confirmed = await confirmPrompt('Install here?');
    if (confirmed === false || confirmed === null) {
      error('Installation cancelled');
      throw new CommandFailedError('Installation cancelled');
    }
  }
  blank();

  const installation = await detectSonarHookInstallation(projectInfo.rootDir);
  const useHusky = toForwardSlash(installation.hooksDir).startsWith(
    toForwardSlash(join(projectInfo.rootDir, '.husky')),
  );
  const usePreCommitConfig = existsSync(join(projectInfo.rootDir, PRE_COMMIT_CONFIG_FILE));

  const hook = await resolveHookType(options);
  text(`Hook: ${hook}`);
  blank();

  await ensureSonarSecrets();

  const huskyHookPath = join(projectInfo.rootDir, '.husky', hook);

  if (usePreCommitConfig) {
    await installViaPreCommitFramework(projectInfo.rootDir, hook);
  } else if (useHusky) {
    await installViaHusky(huskyHookPath, hook);
  } else {
    await installViaGitHooks(installation.hooksDir, hook, options.force);
  }

  showPostInstallInfo(hook);
  await showInstallationStatus(projectInfo.rootDir);
  showVerificationGuide(hook);
}

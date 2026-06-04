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

// Integrate command - install git hooks for secrets scanning

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GLOBAL_HOOKS_DIR } from '../../../../lib/config-constants';
import { normalizePath } from '../../../../lib/fs-utils';
import { findGitRoot } from '../../../../lib/project-workspace';
import { blank, confirmPrompt, intro, selectPrompt, text, warn } from '../../../../ui';
import { CommandFailedError, InvalidOptionError } from '../../_common/error';
import { GitRepo, resolveGitHooksDir } from '../../_common/git-repo';
import { printGitPreflightSummary } from '../_common/preflight-summary';
import { installIntegration } from '../_common/registry';
import type { GitHookType, IntegrateGitOptions } from './options';
import {
  hasSonarHookInPreCommitConfig,
  HOOK_MARKER,
  HUSKY_INTEGRATION_ID,
  NATIVE_GIT_INTEGRATION_ID,
  PRE_COMMIT_INTEGRATION_ID,
} from './tools';

export type { GitHookType, IntegrateGitOptions } from './options';
export { installViaGitHooks } from './tools';

type GitIntegrationId = 'native-git' | 'husky' | 'pre-commit';

export function isGitHookType(s: string): s is GitHookType {
  return s === 'pre-commit' || s === 'pre-push';
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

export { resolveGitHooksDir } from '../../_common/git-repo';

export async function detectSonarHookInstallation(root: string): Promise<HookInstallation> {
  let hooksDir: string;
  try {
    hooksDir = await resolveGitHooksDir(root);
  } catch {
    hooksDir = join(root, '.git', 'hooks');
  }
  const isHusky = normalizePath(hooksDir).startsWith(normalizePath(join(root, '.husky')));
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

/** Rejects invalid `--hook` when it is set */
export function validateHookOption(hook: string | undefined): void {
  if (hook !== undefined && !isGitHookType(hook)) {
    throw new InvalidOptionError('--hook must be pre-commit or pre-push');
  }
}

/**
 * Validates and returns explicit `--hook`, or `pre-commit` when non-interactive with no hook, or prompts to select.
 */
export async function resolveHookType(options: IntegrateGitOptions): Promise<GitHookType> {
  if (options.hook !== undefined) {
    return options.hook;
  }
  if (options.nonInteractive) {
    return 'pre-commit';
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
    throw new CommandFailedError('Installation cancelled');
  }
  return choice;
}

async function integrateGitGlobal(options: IntegrateGitOptions): Promise<void> {
  validateHookOption(options.hook);

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
    const confirmed = await confirmPrompt('Proceed with global installation?', true);
    if (confirmed === false || confirmed === null) {
      throw new CommandFailedError('Installation cancelled');
    }
  }
  blank();

  const hook = await resolveHookType(options);
  text(`Hook: ${hook}`);
  blank();

  await installGitFeatures({ ...options, hook }, GLOBAL_HOOKS_DIR, 'global');
}

export async function integrateGit(options: IntegrateGitOptions): Promise<void> {
  validateHookOption(options.hook);

  intro('SonarQube Git Integration (secrets scanning)');

  if (options.global) {
    return integrateGitGlobal(options);
  }

  const { gitRoot, isGit } = findGitRoot(process.cwd());
  if (!isGit) {
    throw new CommandFailedError('No git repository found.', {
      remediationHint:
        'Run this command from inside a git repository, or use --global to install a global hook.',
    });
  }

  await printGitPreflightSummary(gitRoot);

  if (!options.nonInteractive) {
    const confirmed = await confirmPrompt('Install here?', true);
    if (confirmed === false || confirmed === null) {
      throw new CommandFailedError('Installation cancelled');
    }
  }
  blank();

  const hook = await resolveHookType(options);
  text(`Hook: ${hook}`);
  blank();

  await installGitFeatures({ ...options, hook }, gitRoot, 'project');
}

async function installGitFeatures(
  options: IntegrateGitOptions & { hook: GitHookType },
  targetRoot: string,
  scope: 'project' | 'global',
): Promise<void> {
  const integrationId = await resolveGitIntegrationId(targetRoot, scope);
  await installIntegration({
    integrationId,
    options,
    targetRoot,
    scope,
    force: options.force,
    nonInteractive: options.nonInteractive,
    attrs: {
      hook: options.hook,
    },
  });
}

async function resolveGitIntegrationId(
  targetRoot: string,
  scope: 'project' | 'global',
): Promise<GitIntegrationId> {
  if (scope === 'global') {
    return NATIVE_GIT_INTEGRATION_ID;
  }

  const gitRepo = new GitRepo(targetRoot);
  if (gitRepo.usesPreCommitFramework()) {
    return PRE_COMMIT_INTEGRATION_ID;
  }
  if (await gitRepo.usesHusky()) {
    return HUSKY_INTEGRATION_ID;
  }
  return NATIVE_GIT_INTEGRATION_ID;
}

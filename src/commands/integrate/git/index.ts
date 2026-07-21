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

import type { ResolvedAuth } from '../../../lib/auth-resolver.ts';
import { GLOBAL_HOOKS_DIR } from '../../../lib/config-constants.ts';
import { normalizePath } from '../../../lib/fs-utils.ts';
import { discoverProject, findGitRoot } from '../../../lib/project-workspace';
import { blank, confirmPrompt, info, intro, phase, phaseItem, text, warn } from '../../../ui';
import { yellow } from '../../../ui/colors.ts';
import { printAgentNonInteractiveAlternativeHint } from '../../_common/agent-prompt-hint.ts';
import { CommandFailedError, InvalidOptionError } from '../../_common/error.ts';
import { GitRepo, resolveGitHooksDir } from '../../_common/git-repo.ts';
import { resolveIntegrateScope } from '../_common/integrate-scope.ts';
import { printGitPreflightSummary } from '../_common/preflight-summary.ts';
import { installIntegration } from '../_common/registry';
import { supportedIntegrations } from '../index.ts';
import type { GitHookType, IntegrateGitOptions } from './options.ts';
import {
  getRecognizedHuskyMarkers,
  getRecognizedNativeMarkers,
  hasSonarHookInPreCommitConfig,
  HUSKY_INTEGRATION_ID,
  NATIVE_GIT_INTEGRATION_ID,
  PRE_COMMIT_INTEGRATION_ID,
} from './tools';

export type { GitHookType, IntegrateGitOptions } from './options.ts';

type GitIntegrationId = 'native-git' | 'husky' | 'pre-commit';

export function isGitHookType(s: string): s is GitHookType {
  return s === 'pre-commit' || s === 'pre-push';
}

// ---------------------------------------------------------------------------
// Hook detection
// ---------------------------------------------------------------------------

export function hasMarker(filePath: string, markers: string[]): boolean {
  if (!existsSync(filePath)) {
    return false;
  }
  const content = readFileSync(filePath, 'utf-8');
  return markers.some((marker) => content.includes(marker));
}

interface HookInstallation {
  preCommitConfig: boolean;
  huskyPreCommit: boolean;
  huskyPrePush: boolean;
  gitPreCommit: boolean;
  gitPrePush: boolean;
  hooksDir: string;
}

export { resolveGitHooksDir } from '../../_common/git-repo.ts';

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
    huskyPreCommit:
      isHusky && hasMarker(join(hooksDir, 'pre-commit'), getRecognizedHuskyMarkers('pre-commit')),
    huskyPrePush:
      isHusky && hasMarker(join(hooksDir, 'pre-push'), getRecognizedHuskyMarkers('pre-push')),
    gitPreCommit:
      !isHusky && hasMarker(join(hooksDir, 'pre-commit'), getRecognizedNativeMarkers('pre-commit')),
    gitPrePush:
      !isHusky && hasMarker(join(hooksDir, 'pre-push'), getRecognizedNativeMarkers('pre-push')),
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

async function integrateGitGlobal(options: IntegrateGitOptions, auth: ResolvedAuth): Promise<void> {
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

  await installGitFeatures(options, GLOBAL_HOOKS_DIR, 'global', auth);
}

export async function integrateGit(
  options: IntegrateGitOptions,
  auth: ResolvedAuth,
): Promise<void> {
  validateHookOption(options.hook);

  if (options.global && (options.dependencyRisks || options.project)) {
    throw new InvalidOptionError('--dependency-risks and -p are not supported with --global.');
  }

  if (!options.nonInteractive) {
    printAgentNonInteractiveAlternativeHint('sonar integrate git --non-interactive');
  }

  intro('SonarQube Git Integration (source code scanning)');
  info('This integration includes secrets and dependency risks detection in your git repository.');
  info(yellow('Some scan types may be unavailable for certain hook types.'));

  if (options.global) {
    return integrateGitGlobal(options, auth);
  }

  const { gitRoot, isGit } = findGitRoot(process.cwd());
  if (isGit) {
    await printGitPreflightSummary(gitRoot);
    blank();
  }

  const scope = await resolveIntegrateScope({
    ...options,
    projectKey: options.project,
    projectRoot: isGit ? gitRoot : process.cwd(),
  });
  if (scope === 'global') {
    return integrateGitGlobal(options, auth);
  }

  if (!isGit) {
    throw new CommandFailedError('No git repository found.', {
      remediationHint:
        'Run this command from inside a git repository, or use --global to install a global hook.',
    });
  }

  const resolvedOptions = await resolveProjectKey(options, gitRoot, auth);

  await installGitFeatures(resolvedOptions, gitRoot, 'project', auth);
}

async function resolveProjectKey(
  options: IntegrateGitOptions,
  root: string,
  auth: ResolvedAuth,
): Promise<IntegrateGitOptions> {
  if (options.project) {
    phase('Project', [phaseItem('Key', 'done', options.project)]);
    return options;
  }

  const discovered = await discoverProject(root, true, { auth });
  if (discovered.projectKey) {
    phase('Project', [phaseItem('Key', 'done', discovered.projectKey)]);
    return { ...options, project: discovered.projectKey };
  }

  warn(
    'No project key detected — some features will not be available. Run `sonar integrate git --help` for ways to define a project.',
  );
  return options;
}

async function installGitFeatures(
  options: IntegrateGitOptions,
  targetRoot: string,
  scope: 'project' | 'global',
  auth: ResolvedAuth,
): Promise<void> {
  const integrationId = await resolveGitIntegrationId(targetRoot, scope);
  await installIntegration({
    registry: supportedIntegrations,
    integrationId,
    options,
    targetRoot,
    scope,
    auth,
    force: options.force,
    nonInteractive: options.nonInteractive,
    isFromRouter: options.isFromRouter,
    // Attrs are project-scope only; global hooks do not support a project key.
    attrs: scope === 'project' ? { projectKey: options.project ?? null } : undefined,
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

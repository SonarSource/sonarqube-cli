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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { GLOBAL_HOOKS_DIR } from '@/core/config-constants.ts';
import { installIntegration } from '@/core/framework/features';
import { findGitRoot } from '@/core/host/git/discover.ts';
import { GitRepo, resolveGitHooksDir } from '@/core/host/git/hooks.ts';
import { normalizePath } from '@/core/io/fs-utils.ts';
import { discoverProject } from '@/core/project-info.ts';
import { phaseItem } from '@/core/ui';
import { yellow } from '@/core/ui/colors.ts';
import { printAgentNonInteractiveAlternativeHint } from '@/core/ui/components/agent-prompt-hint.ts';
import type { Console } from '@/core/ui/console.ts';

import { resolveIntegrateScope } from '../_common/integrate-scope.ts';
import { recordIntegrationConfigured } from '../_common/integrate-telemetry.ts';
import { printGitPreflightSummary } from '../_common/preflight-summary.ts';
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

export { resolveGitHooksDir } from '@/core/host/git/hooks.ts';

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

async function integrateGitGlobal(
  options: IntegrateGitOptions,
  auth: ResolvedAuth,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { console } = ctx;
  validateHookOption(options.hook);

  console.warn('Global hook installation');
  console.text('  Git prioritizes local repository settings over global ones.');
  console.text('  If a project has a local core.hooksPath set,');
  console.text('  this global hook will NOT run in that project.');
  console.blank();
  console.text(
    '  To enable the global hook in such a project, you will need to unset its local path:',
  );
  console.text('    git config --unset core.hooksPath');
  console.blank();
  console.text('  This will set git config --global core.hooksPath to:');
  console.text(`  ${GLOBAL_HOOKS_DIR}`);
  console.blank();

  if (!options.nonInteractive) {
    const confirmed = await console.confirmPrompt('Proceed with global installation?', true);
    if (confirmed === false || confirmed === null) {
      throw new CommandFailedError('Installation cancelled');
    }
  }
  console.blank();

  await installGitFeatures(options, GLOBAL_HOOKS_DIR, 'global', auth, ctx);
}

export async function integrateGit(
  options: IntegrateGitOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth, console } = ctx;
  validateHookOption(options.hook);

  if (options.global && (options.dependencyRisks || options.project)) {
    throw new InvalidOptionError('--dependency-risks and -p are not supported with --global.');
  }

  if (!options.nonInteractive) {
    printAgentNonInteractiveAlternativeHint(console, 'sonar integrate git --non-interactive');
  }

  console.intro('SonarQube Git Integration (source code scanning)');
  console.info(
    'This integration includes secrets and dependency risks detection in your git repository.',
  );
  console.info(yellow('Some scan types may be unavailable for certain hook types.'));

  if (options.global) {
    return integrateGitGlobal(options, auth, ctx);
  }

  const { gitRoot, isGit } = findGitRoot(process.cwd());
  if (isGit) {
    await printGitPreflightSummary(gitRoot, console);
    console.blank();
  }

  const scope = await resolveIntegrateScope({
    ...options,
    projectKey: options.project,
    projectRoot: isGit ? gitRoot : process.cwd(),
    console,
  });
  if (scope === 'global') {
    return integrateGitGlobal(options, auth, ctx);
  }

  if (!isGit) {
    throw new CommandFailedError('No git repository found.', {
      remediationHint:
        'Run this command from inside a git repository, or use --global to install a global hook.',
    });
  }

  const resolvedOptions = await resolveProjectKey(options, gitRoot, auth, console);

  await installGitFeatures(resolvedOptions, gitRoot, 'project', auth, ctx);
}

async function resolveProjectKey(
  options: IntegrateGitOptions,
  root: string,
  auth: ResolvedAuth,
  console: Console,
): Promise<IntegrateGitOptions> {
  if (options.project) {
    console.phase('Project', [phaseItem('Key', 'done', options.project)]);
    return options;
  }

  const discovered = await discoverProject(root, { auth, silent: true, console });
  if (discovered.projectKey) {
    console.phase('Project', [phaseItem('Key', 'done', discovered.projectKey)]);
    return { ...options, project: discovered.projectKey };
  }

  console.warn(
    'No project key detected — some features will not be available. Run `sonar integrate git --help` for ways to define a project.',
  );
  return options;
}

async function installGitFeatures(
  options: IntegrateGitOptions,
  targetRoot: string,
  scope: 'project' | 'global',
  auth: ResolvedAuth,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const integrationId = await resolveGitIntegrationId(targetRoot, scope);
  await installIntegration({
    registry: supportedIntegrations,
    integrationId,
    options,
    targetRoot,
    scope,
    console: ctx.console,
    auth,
    force: options.force,
    nonInteractive: options.nonInteractive,
    // Attrs are project-scope only; global hooks do not support a project key.
    attrs: scope === 'project' ? { projectKey: options.project ?? null } : undefined,
    onSuccess: (facts) => {
      recordIntegrationConfigured(ctx, {
        auth,
        integrationId,
        scope,
        nonInteractive: options.nonInteractive ?? false,
        isFromRouter: options.isFromRouter ?? false,
        ...facts,
      });
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

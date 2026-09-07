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

// git pre-commit callback handler — scans staged files for secrets and,
// when --dependency-risks is set, runs a dependency-risks scan as a follow-up stage.
// Replaces the shell logic that was previously embedded in the git hook script.

import { resolveAuth, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { InvalidOptionError } from '@/core/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { spawnProcess } from '@/core/process/process.ts';
import { discoverProject } from '@/core/project-info.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import type { Console } from '@/core/ui/console.ts';

import { runDepRisksStage } from './git-pre-commit-dependency-risks.ts';
import { runCommitSecretsStage } from './git-pre-commit-secrets.ts';
import { HOOK_INACTIVE_UNAUTHENTICATED, MissingDependenciesError } from './hook-dependencies.ts';

export interface GitPreCommitOptions {
  project?: string;
  dependencyRisks?: boolean;
}

/**
 * Resolves the project key for --dependency-risks, falling back to project
 * discovery when `-p` was not passed. A secrets-only pre-commit hook is
 * intentionally project-agnostic and never bakes a `-p`, so the fallback is
 * skipped entirely when --dependency-risks is not set.
 */
async function resolveDepRisksProjectKey(
  options: GitPreCommitOptions,
  auth: ResolvedAuth | null,
  console: Console,
): Promise<string | undefined> {
  if (options.project) {
    return options.project;
  }
  if (!options.dependencyRisks || !auth) {
    return undefined;
  }
  const discovered = await discoverProject(process.cwd(), { auth, silent: true, console });
  return discovered.projectKey;
}

export async function gitPreCommit(
  options: GitPreCommitOptions,
  files: string[],
  ctx: CommandInvocationContext,
): Promise<void> {
  const auth = await resolveAuth().catch(() => null);

  // Validated up front, independent of staged files, so a misconfigured hook
  // (--dependency-risks with no way to resolve a project) always fails loudly.
  const projectKey = await resolveDepRisksProjectKey(options, auth, ctx.console);

  if (options.dependencyRisks && !projectKey) {
    throw new InvalidOptionError('--dependency-risks requires -p <projectKey>.');
  }

  const stagedFiles = files.length > 0 ? files : await getStagedFiles();
  if (stagedFiles.length === 0) return;

  if (!auth) {
    throw new MissingDependenciesError(HOOK_INACTIVE_UNAUTHENTICATED);
  }

  // Noted before the stages, not inside the dependency-risks one, so a `-p` passed without
  // --dependency-risks is still reported. In practice integrate only bakes `-p` into the hook
  // alongside --dependency-risks, so a secrets-only pre-commit correctly reports null.
  noteProject(auth, projectKey);

  await runCommitSecretsStage(stagedFiles, auth, ctx);

  if (options.dependencyRisks && projectKey) {
    await runDepRisksStage({
      project: projectKey,
      changedFiles: stagedFiles,
      auth,
      ctx,
    });
  }
}

async function getStagedFiles(): Promise<string[]> {
  try {
    const result = await spawnProcess('git', [
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=ACMR',
    ]);
    if (result.exitCode !== 0) return [];
    return result.stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

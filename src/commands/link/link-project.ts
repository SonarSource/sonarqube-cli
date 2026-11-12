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

import { join } from 'node:path';

import { requireCloudOrganization, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import {
  InvalidLinkPathError,
  type LinkMode,
  linkProjectDirectories,
  type LinkTarget,
  resolveLinkTarget,
  type SavedLinks,
} from '@/core/project-discovery/link-target.ts';

import { assertCanChooseProject, chooseProjectKey } from './choose-project.ts';

export interface LinkOptions {
  path: string;
  monorepo?: boolean;
}

function assertLinkableConnection(auth: ResolvedAuth): void {
  if (auth.connectionType === 'cloud') {
    requireCloudOrganization(auth);
  }
}

export function linkProject(
  projectKey: string | undefined,
  options: LinkOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  return options.monorepo
    ? linkMonorepoProject(projectKey, options, ctx)
    : linkSingleProject(projectKey, options, ctx);
}

/** Single-project link: replaces the legacy singular `project` binding. */
function linkSingleProject(
  projectKey: string | undefined,
  options: LinkOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  return runLink(projectKey, options, ctx, false);
}

/** Monorepo link: adds or updates a mapping in the `projects` array. */
function linkMonorepoProject(
  projectKey: string | undefined,
  options: LinkOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  return runLink(projectKey, options, ctx, true);
}

/** Fails before any prompt, server call or write when the request cannot be carried out. */
function assertLinkable(
  givenKey: string | undefined,
  { path }: LinkOptions,
  ctx: CommandAuthenticatedInvocationContext,
): void {
  if (path.trim().length === 0) {
    throw new CommandFailedError('--path must not be empty.', {
      remediationHint: "Use '--path .' for a project at the repository root.",
    });
  }

  assertLinkableConnection(ctx.auth);
  if (givenKey === undefined) {
    assertCanChooseProject(ctx);
  }
}

async function resolveTarget(
  path: string,
  { console }: CommandAuthenticatedInvocationContext,
): Promise<LinkTarget> {
  let target: LinkTarget;
  try {
    target = await resolveLinkTarget(process.cwd(), path);
  } catch (error) {
    if (!(error instanceof InvalidLinkPathError)) {
      throw error;
    }
    throw new CommandFailedError(error.message, {
      remediationHint:
        'Use a path relative to the repository root, e.g. --path . or --path services/api.',
    });
  }

  // Raised only after the path validated, so a rejected path never gets the
  // misleading "writing to cwd instead" message.
  if (!target.inGitRepository) {
    console.warn('No git repository found. Writing to the current directory instead.');
  }
  return target;
}

function reportLinked(
  console: CommandAuthenticatedInvocationContext['console'],
  { targetDir, projectRoot, inGitRepository }: LinkTarget,
  projectKey: string,
  { linkedCount, removedProjectKeys }: SavedLinks,
): void {
  if (removedProjectKeys.length > 0) {
    console.warn(
      `Removed the other mappings in ${SHARED_PROJECT_CONFIG_FILE_NAME} (${removedProjectKeys.join(', ')}). Use 'sonar link --monorepo' to add a link without replacing them.`,
    );
  }
  const mapping = linkedCount > 1 ? ' (monorepo mapping)' : '';
  const summaryLines = [
    `Linked ${projectRoot} to project ${projectKey}${mapping}`,
    `Config saved to ${join(targetDir, SHARED_PROJECT_CONFIG_FILE_NAME)}`,
  ];
  if (inGitRepository) {
    summaryLines.push(`Commit ${SHARED_PROJECT_CONFIG_FILE_NAME} to share it.`);
  }
  console.success(summaryLines.join('\n'));
}

/** Validates the request, picks the project key when none was given, writes the link, reports it. */
async function runLink(
  givenKey: string | undefined,
  options: LinkOptions,
  ctx: CommandAuthenticatedInvocationContext,
  monorepo: boolean,
): Promise<void> {
  assertLinkable(givenKey, options, ctx);
  const target = await resolveTarget(options.path, ctx);

  const projectKey = givenKey ?? (await chooseProjectKey(target.projectRoot, monorepo, ctx));
  if (projectKey === null) {
    return;
  }

  // --monorepo joins what is already linked; a plain link replaces it.
  const mode: LinkMode = monorepo ? 'merge' : 'replace';
  const saved = await linkProjectDirectories(
    ctx.auth,
    target.targetDir,
    [{ projectKey, projectRoot: target.projectRoot }],
    mode,
  );
  reportLinked(ctx.console, target, projectKey, saved);
}

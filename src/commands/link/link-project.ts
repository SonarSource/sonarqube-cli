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
  type ProjectLink,
  relativeProjectPath,
  resolveConfigDir,
  resolveLinkTarget,
  type SavedLinks,
} from '@/core/project-discovery/link-target.ts';

import { chooseProjectFolders } from './choose-folder.ts';
import { assertCanChooseProject, chooseProjectKey } from './choose-project.ts';
import { TreeFolderPicker } from './folder-picker.ts';

export interface LinkOptions {
  /** Omitted: picked interactively when no project key is given either, else the root. */
  path?: string;
  monorepo?: boolean;
}

function assertLinkableConnection(auth: ResolvedAuth): void {
  if (auth.connectionType === 'cloud') {
    requireCloudOrganization(auth);
  }
}

/** Fails before any prompt, server call or write when the request cannot be carried out. */
function assertLinkable(
  givenKey: string | undefined,
  { path }: LinkOptions,
  ctx: CommandAuthenticatedInvocationContext,
): void {
  if (path?.trim().length === 0) {
    throw new CommandFailedError('--path must not be empty.', {
      remediationHint: "Use '--path .' for a project at the repository root.",
    });
  }

  assertLinkableConnection(ctx.auth);
  if (givenKey === undefined) {
    assertCanChooseProject(ctx);
  }
}

/** The folders the user ticks, at least one. */
async function chooseTargets({
  console,
}: CommandAuthenticatedInvocationContext): Promise<LinkTarget[]> {
  const { targetDir, inGitRepository } = await resolveConfigDir(process.cwd());
  if (!inGitRepository) {
    console.warn('No git repository found. Writing to the current directory instead.');
  }
  const folders = await chooseProjectFolders(
    targetDir,
    inGitRepository,
    new TreeFolderPicker(console),
  );
  return folders.map((projectRoot) => ({ targetDir, projectRoot, inGitRepository }));
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

function savedConfigLines({ targetDir, inGitRepository }: LinkTarget): string[] {
  const lines = [`Config saved to ${join(targetDir, SHARED_PROJECT_CONFIG_FILE_NAME)}`];
  if (inGitRepository) {
    lines.push(`Commit ${SHARED_PROJECT_CONFIG_FILE_NAME} to share it.`);
  }
  return lines;
}

function reportLinked(
  console: CommandAuthenticatedInvocationContext['console'],
  target: LinkTarget,
  links: readonly ProjectLink[],
  { linkedCount, removedProjectKeys }: SavedLinks,
): void {
  if (removedProjectKeys.length > 0) {
    console.warn(
      `Removed the other mappings in ${SHARED_PROJECT_CONFIG_FILE_NAME} (${removedProjectKeys.join(', ')}). Use 'sonar link --monorepo' to add a link without replacing them.`,
    );
  }
  const [first] = links;
  if (links.length === 1) {
    const mapping = linkedCount > 1 ? ' (monorepo mapping)' : '';
    console.success(
      [
        `Linked ${first.projectRoot} to project ${first.projectKey}${mapping}`,
        ...savedConfigLines(target),
      ].join('\n'),
    );
    return;
  }
  const rows = links.map(
    ({ projectRoot, projectKey }) =>
      `  ${relativeProjectPath(target.targetDir, projectRoot)} → ${projectKey}`,
  );
  console.success(
    [
      `Linked ${links.length} folders (monorepo mappings):`,
      ...rows,
      ...savedConfigLines(target),
    ].join('\n'),
  );
}

/** Validates the request, picks the project key when none was given, writes the link, reports it. */
export async function linkProject(
  givenKey: string | undefined,
  options: LinkOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  assertLinkable(givenKey, options, ctx);
  const picking = options.path === undefined && givenKey === undefined;
  const targets = picking
    ? await chooseTargets(ctx)
    : [await resolveTarget(options.path ?? '.', ctx)];
  // Folders picked in the tree join what is already linked; a plain 'sonar link <key>' replaces it.
  const mode: LinkMode = picking || options.monorepo ? 'merge' : 'replace';

  const links = await chooseLinks(
    givenKey,
    targets,
    { monorepo: mode === 'merge', announce: targets.length > 1 },
    ctx,
  );
  if (links.length === 0) {
    return;
  }
  const [target] = targets;
  const saved = await linkProjectDirectories(ctx.auth, target.targetDir, links, mode);
  reportLinked(ctx.console, target, links, saved);
}

/**
 * The project for each target, prompting folder by folder; targets whose existing link is kept
 * are left out. Nothing is written yet, so leaving a later prompt saves none of them.
 */
async function chooseLinks(
  givenKey: string | undefined,
  targets: readonly LinkTarget[],
  options: { monorepo: boolean; announce: boolean },
  ctx: CommandAuthenticatedInvocationContext,
): Promise<ProjectLink[]> {
  if (targets.length === 0) {
    return [];
  }
  const [{ targetDir, projectRoot }, ...rest] = targets;
  if (options.announce) {
    ctx.console.info(`Choosing the project for ${relativeProjectPath(targetDir, projectRoot)}`);
  }
  const projectKey = givenKey ?? (await chooseProjectKey(projectRoot, options.monorepo, ctx));
  const chosen = projectKey === null ? [] : [{ projectRoot, projectKey }];
  // The next folder's prompts start only once this one is settled.
  return [...chosen, ...(await chooseLinks(givenKey, rest, options, ctx))];
}

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

import { relative, resolve, sep } from 'node:path';

import { requireCloudOrganization, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { SONARCLOUD_URL, SONARCLOUD_US_URL } from '@/core/config-constants.ts';
import { resolveGitRepoRoot } from '@/core/host/git/worktree.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import { cloudRegionFromUrl } from '@/core/server/sonarcloud-region.ts';

import {
  resolveContainedPath,
  type SharedProjectConfigEntry,
  sharedProjectConfigRepository,
} from './shared-project-config.ts';

export interface LinkTarget {
  /** Where `.sonar-config.json` lives: the git root, else the starting directory. */
  targetDir: string;
  projectRoot: string;
  inGitRepository: boolean;
}

/** The requested project path is absolute, escapes the config directory or is not a directory. */
export class InvalidLinkPathError extends Error {
  constructor(
    readonly path: string,
    readonly targetDir: string,
  ) {
    super(`--path "${path}" must point to an existing directory inside ${targetDir}.`);
    this.name = 'InvalidLinkPathError';
  }
}

/** What `saveProjectLink()` observed, for the caller to report in its own words. */
export interface SavedLink {
  /** Key of the mapping this write replaced for the same directory, if any. */
  replacedProjectKey?: string;
  /** The link was written but a `projects` array takes precedence, so it has no effect. */
  shadowed: boolean;
}

export function deriveEntry(
  auth: ResolvedAuth,
  projectKey: string,
  path: string,
): SharedProjectConfigEntry {
  if (auth.connectionType !== 'cloud') {
    return { projectKey, path, serverUrl: auth.serverUrl };
  }

  const organization = requireCloudOrganization(auth);

  const region = cloudRegionFromUrl(auth.serverUrl);
  const origin = region ? new URL(auth.serverUrl).origin : undefined;
  if (!region || (origin !== SONARCLOUD_URL && origin !== SONARCLOUD_US_URL)) {
    return { projectKey, path, serverUrl: auth.serverUrl, organization };
  }
  return { projectKey, path, region, organization };
}

/** The directory `.sonar-config.json` goes in for a project started at `startDir`. */
export async function resolveConfigDir(
  startDir: string,
): Promise<{ targetDir: string; inGitRepository: boolean }> {
  const gitRoot = await resolveGitRepoRoot(startDir);
  return { targetDir: canonicalizePath(gitRoot ?? startDir), inGitRepository: gitRoot !== null };
}

/** Resolves `path` (relative to the config directory) to the project root it names. */
export async function resolveLinkTarget(startDir: string, path: string): Promise<LinkTarget> {
  const { targetDir, inGitRepository } = await resolveConfigDir(startDir);
  const projectRoot = resolveContainedPath(targetDir, path);
  if (projectRoot === null) {
    throw new InvalidLinkPathError(path, targetDir);
  }
  return { targetDir, projectRoot, inGitRepository };
}

/** `projectRoot` as a forward-slash path relative to `targetDir`, `.` for the directory itself. */
export function relativeProjectPath(targetDir: string, projectRoot: string): string {
  return relative(targetDir, canonicalizePath(projectRoot)).split(sep).join('/') || '.';
}

/**
 * Writes `entry` into `<dir>/.sonar-config.json`: as the singular `project` by default,
 * into the `projects` array in monorepo mode.
 */
export async function saveProjectLink(
  dir: string,
  entry: SharedProjectConfigEntry,
  { monorepo }: { monorepo: boolean },
): Promise<SavedLink> {
  const target = canonicalizePath(resolve(dir, entry.path));
  const previous = (await sharedProjectConfigRepository.load(dir)).find(
    (mapping) => canonicalizePath(mapping.projectRoot) === target,
  );

  if (monorepo) {
    await sharedProjectConfigRepository.addProject(dir, entry);
    return { replacedProjectKey: previous?.projectKey, shadowed: false };
  }
  const shadowed = await sharedProjectConfigRepository.set(dir, entry);
  return { replacedProjectKey: previous?.projectKey, shadowed };
}

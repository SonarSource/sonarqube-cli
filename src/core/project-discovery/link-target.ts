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

import { relative, sep } from 'node:path';

import { requireCloudOrganization, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { SONARCLOUD_URL, SONARCLOUD_US_URL } from '@/core/config-constants.ts';
import { resolveGitRepoRoot } from '@/core/host/git/worktree.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import { cloudRegionFromUrl } from '@/core/server/sonarcloud-region.ts';

import {
  type ConfigItem,
  resolveContainedPath,
  SHARED_PROJECT_CONFIG_ENTRY_FIELDS,
  type SharedProjectConfigEntry,
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

export interface ProjectLink {
  projectKey: string;
  projectRoot: string;
}

function deriveEntry(
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

/** The target for a project root that is already known, as `sonar init` has it. */
export async function resolveProjectTarget(projectRoot: string): Promise<LinkTarget> {
  const { targetDir, inGitRepository } = await resolveConfigDir(projectRoot);
  return { targetDir, projectRoot, inGitRepository };
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

/** The item linking `projectRoot` to `projectKey` on the active connection. */
export function linkItem(
  auth: ResolvedAuth,
  targetDir: string,
  projectRoot: string,
  projectKey: string,
): ConfigItem {
  const entry = deriveEntry(auth, projectKey, relativeProjectPath(targetDir, projectRoot));
  return { entry, root: canonicalizePath(projectRoot) };
}

/**
 * `items` with `item` in place of the one for the same folder, or appended when there is none. A
 * replaced entry's fields outside the schema, such as `settings`, carry over to `item`.
 */
export function withLink(items: readonly ConfigItem[], item: ConfigItem): ConfigItem[] {
  if (!items.some((existing) => existing.root === item.root)) {
    return [...items, item];
  }
  return items.map((existing) =>
    existing.root === item.root
      ? { ...item, entry: { ...fieldsOutsideSchema(existing.entry), ...item.entry } }
      : existing,
  );
}

function fieldsOutsideSchema(entry: SharedProjectConfigEntry): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).filter(([field]) => !SHARED_PROJECT_CONFIG_ENTRY_FIELDS.includes(field)),
  );
}

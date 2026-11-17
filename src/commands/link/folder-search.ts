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

// Finds folders anywhere under the repository root by name, for the `sonar link` folder picker.

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { tryRunGit } from '@/core/host/git/exec.ts';

// Outside git nothing like node_modules is ignored, so the walk is bounded instead.
const MAX_DEPTH_OUTSIDE_GIT = 8;
const MAX_FOLDERS = 50_000;

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/**
 * Drops the folders git ignores, given as paths relative to `cwd`; outside a repository nothing
 * is dropped. Only a folder that is ignored itself is dropped, not one whose contents all are.
 */
async function withoutIgnored(cwd: string, folders: string[]): Promise<string[]> {
  if (folders.length === 0) return folders;
  // -z keeps names unquoted; exit code 1, nothing ignored, reads as `undefined` like no repository.
  // --no-index stops a path inside a submodule from failing the whole batch.
  const output = await tryRunGit(
    ['check-ignore', '--no-index', '-z', '--stdin'],
    cwd,
    folders.join('\0'),
  );
  if (output === undefined) return folders;
  const ignored = new Set(output.split('\0'));
  return folders.filter((folder) => !ignored.has(folder));
}

/**
 * The folders, relative to `cwd`, that can be linked: neither git-ignored nor a submodule or other
 * nested repository, where project discovery stops before reaching the outer `.sonar-config.json`.
 */
export async function linkableFolders(cwd: string, folders: string[]): Promise<string[]> {
  const outsideRepositories = folders.filter((folder) => !existsSync(join(cwd, folder, '.git')));
  return withoutIgnored(cwd, outsideRepositories);
}

/**
 * Every folder under `root` the tree would show, as forward-slash paths relative to it: hidden,
 * git-ignored and nested-repository folders are left out, empty ones (which git does not track)
 * are kept.
 */
export async function listAllFolders(root: string): Promise<string[]> {
  const inGit = (await tryRunGit(['rev-parse', '--is-inside-work-tree'], root)) !== undefined;
  const maxDepth = inGit ? Infinity : MAX_DEPTH_OUTSIDE_GIT;
  return walkLevels(root, [''], { depthLeft: maxDepth, budget: MAX_FOLDERS });
}

async function subfolders(root: string, rel: string): Promise<string[]> {
  const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !isHidden(entry.name))
    .map((entry) => (rel ? `${rel}/${entry.name}` : entry.name));
}

/** Breadth-first: each level is read in parallel, and the next only once it is known. */
async function walkLevels(
  root: string,
  level: readonly string[],
  { depthLeft, budget }: { depthLeft: number; budget: number },
): Promise<string[]> {
  if (level.length === 0 || depthLeft <= 0 || budget <= 0) return [];
  const listings = await Promise.all(level.map((rel) => subfolders(root, rel)));
  const found = (await linkableFolders(root, listings.flat())).slice(0, budget);
  const deeper = await walkLevels(root, found, {
    depthLeft: depthLeft - 1,
    budget: budget - found.length,
  });
  return [...found, ...deeper];
}

/** Lowercased, with whitespace dropped, so a query typed without spaces still finds `My App`. */
function normalize(text: string): string {
  return text.toLowerCase().replaceAll(/\s+/g, '');
}

function folderName(folder: string): string {
  return folder.slice(folder.lastIndexOf('/') + 1);
}

function depthOf(folder: string): number {
  return folder.split('/').length;
}

/** The folders whose own name contains `query`, shallowest first. */
export function matchFolders(folders: readonly string[], query: string): string[] {
  const needle = normalize(query);
  return folders
    .filter((folder) => normalize(folderName(folder)).includes(needle))
    .sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
}

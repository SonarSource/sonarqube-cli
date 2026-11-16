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

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { tryRunGitLines } from '@/core/host/git/exec.ts';
import { decodeGitPath } from '@/core/host/git/quoted-path.ts';

// Outside git nothing like node_modules is ignored, so the walk is bounded instead.
const MAX_DEPTH_OUTSIDE_GIT = 8;
const MAX_FOLDERS = 50_000;

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

/** The folders git ignores under `root`, as forward-slash paths; `undefined` outside git. */
async function ignoredFolders(root: string): Promise<Set<string> | undefined> {
  // --directory lists an ignored folder once instead of every file in it.
  const paths = await tryRunGitLines(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    root,
  );
  if (paths === undefined) return undefined;
  const folders = paths.map(decodeGitPath).filter((path) => path.endsWith('/'));
  return new Set(folders.map((folder) => folder.slice(0, -1)));
}

/**
 * Every folder under `root` the tree would show, as forward-slash paths relative to it: hidden
 * and git-ignored folders are left out, empty ones (which git does not track) are kept.
 */
export async function listAllFolders(root: string): Promise<string[]> {
  const ignored = await ignoredFolders(root);
  const maxDepth = ignored === undefined ? MAX_DEPTH_OUTSIDE_GIT : Infinity;
  return walkLevels(root, [''], ignored, { depthLeft: maxDepth, budget: MAX_FOLDERS });
}

async function subfolders(
  root: string,
  rel: string,
  ignored: Set<string> | undefined,
): Promise<string[]> {
  const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !isHidden(entry.name))
    .map((entry) => (rel ? `${rel}/${entry.name}` : entry.name))
    .filter((folder) => !ignored?.has(folder));
}

/** Breadth-first: each level is read in parallel, and the next only once it is known. */
async function walkLevels(
  root: string,
  level: readonly string[],
  ignored: Set<string> | undefined,
  { depthLeft, budget }: { depthLeft: number; budget: number },
): Promise<string[]> {
  if (level.length === 0 || depthLeft <= 0 || budget <= 0) return [];
  const listings = await Promise.all(level.map((rel) => subfolders(root, rel, ignored)));
  const found = listings.flat().slice(0, budget);
  const deeper = await walkLevels(root, found, ignored, {
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

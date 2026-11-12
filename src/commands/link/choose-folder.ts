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

// Picks the directory for `sonar link` when neither a project key nor --path is given.

import { isAbsolute, relative } from 'node:path';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import { sharedProjectConfigRepository } from '@/core/project-discovery/shared-project-config.ts';

import type { FolderPicker } from './folder-picker.ts';

/** Project keys by the canonical folder they are linked to in `root`'s `.sonar-config.json`. */
async function loadLinkedFolders(root: string): Promise<Map<string, string>> {
  const mappings = await sharedProjectConfigRepository.load(root);
  return new Map(
    mappings.map((mapping) => [canonicalizePath(mapping.projectRoot), mapping.projectKey]),
  );
}

function isStrictlyInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** `linked to <key>` for a linked folder, plus how many linked folders lie deeper inside it. */
function linkedDetail(linked: Map<string, string>, dir: string): string | undefined {
  const folder = canonicalizePath(dir);
  const projectKey = linked.get(folder);
  const deeper = [...linked.keys()].filter((path) => isStrictlyInside(path, folder)).length;
  const parts: string[] = [];
  if (projectKey !== undefined) parts.push(`linked to ${projectKey}`);
  if (deeper > 0) parts.push(`${deeper} ${deeper === 1 ? 'project' : 'projects'} deeper`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * Lets the user tick the project roots under `root`, the directory `.sonar-config.json` goes in:
 * the root itself, or any number of folders at any depth, each marked with what it is linked to.
 */
export async function chooseProjectFolders(
  root: string,
  inGitRepository: boolean,
  picker: FolderPicker,
): Promise<string[]> {
  const linked = await loadLinkedFolders(root);
  const folders = await picker.pick(root, {
    message: 'Choose the project folders',
    rootLabel: inGitRepository ? '. (repository root)' : '. (current directory)',
    annotate: (folder) => linkedDetail(linked, folder),
  });
  if (folders === null) {
    throw new CommandFailedError('Folder selection cancelled');
  }
  return folders;
}

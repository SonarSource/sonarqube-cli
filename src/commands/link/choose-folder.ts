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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { canonicalizePath, isAncestorOrSelf } from '@/core/io/fs-utils.ts';
import {
  type ConfigItem,
  resolveContainedPath,
} from '@/core/project-discovery/shared-project-config.ts';
import type { Console } from '@/core/ui/console.ts';

import type { FolderPicker } from './folder-picker.ts';

export interface ChooseFoldersOptions {
  inGitRepository: boolean;
  /** What `.sonar-config.json` links now. */
  items: readonly ConfigItem[];
  /** `--monorepo` was given, so the tree opens without asking first. */
  monorepo: boolean;
}

/** `linked to <key>` for a linked folder, plus how many linked folders lie deeper inside it. */
function linkedDetail(linked: readonly ConfigItem[], dir: string): string | undefined {
  const folder = canonicalizePath(dir);
  const own = linked.find((item) => item.root === folder);
  const deeper = linked.filter(
    (item) => item.root !== folder && isAncestorOrSelf(folder, item.root),
  ).length;
  const parts: string[] = [];
  if (own !== undefined) parts.push(`linked to ${own.entry.projectKey}`);
  if (deeper > 0) parts.push(`${deeper} ${deeper === 1 ? 'project' : 'projects'} deeper`);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function cancelled(): CommandFailedError {
  return new CommandFailedError('Folder selection cancelled');
}

/** Opened straight away for a monorepo; otherwise only offered, defaulting to linking the root alone. */
async function wantsTree(
  { inGitRepository, items, monorepo }: ChooseFoldersOptions,
  console: Console,
): Promise<boolean> {
  if (monorepo || items.length > 1) return true;
  console.info(
    'The linked folder should be the same root folder the server uses to analyze the project.',
  );
  const linkRoot = await console.selectPrompt('Choose the folder to link', [
    {
      value: true,
      label: inGitRepository ? 'Repository root (default)' : 'Current directory (default)',
    },
    { value: false, label: 'Choose another' },
  ]);
  if (linkRoot === null) throw cancelled();
  return !linkRoot;
}

/**
 * Lets the user tick the project roots under `root`, the directory `.sonar-config.json` goes in:
 * the root itself, or any number of folders at any depth, each marked with what `items` link it to.
 * Resolves to `undefined` when `root` alone is to be linked, without the tree.
 */
export async function chooseProjectFolders(
  root: string,
  options: ChooseFoldersOptions,
  picker: FolderPicker,
  console: Console,
): Promise<string[] | undefined> {
  if (!(await wantsTree(options, console))) {
    return undefined;
  }
  const { inGitRepository, items } = options;
  const linked = items.filter((item) => resolveContainedPath(root, item.entry.path) !== null);
  const folders = await picker.pick(root, {
    message: 'Choose the project folders',
    rootLabel: inGitRepository ? '. (repository root)' : '. (current directory)',
    annotate: (folder) => linkedDetail(linked, folder),
  });
  if (folders === null) {
    throw cancelled();
  }
  return folders;
}

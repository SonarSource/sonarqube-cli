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

import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { tryRunGitLines } from '@/core/host/git/exec.ts';
import logger from '@/core/observability/logger.ts';
import type { Console, SearchResults } from '@/core/ui/console.ts';
import type { TreeNode, TreePromptOptions } from '@/core/ui/tree/tree-source.ts';

import { listAllFolders, matchFolders } from './folder-search.ts';

const MAX_SEARCH_RESULTS = 50;

export interface FolderPickerOptions {
  /** The question above the folders. */
  message: string;
  /** How the starting folder reads at the top of the tree. Defaults to `.`. */
  rootLabel?: string;
  /** Shown next to a folder in the tree and in search results, e.g. what it is linked to. */
  annotate?: (folder: string) => string | undefined;
}

export interface FolderPicker {
  /**
   * Lets the user tick folders under `root`, the root included; hidden and git-ignored folders are
   * left out. Resolves to the ticked folders (never empty), to `[root]` without prompting when it
   * has no folders, or to `null` when the user cancels.
   */
  pick(root: string, options: FolderPickerOptions): Promise<string[] | null>;
}

/** A tree the user expands and searches by folder name, ticking folders at any depth. */
export class TreeFolderPicker implements FolderPicker {
  constructor(private readonly console: Console) {}

  async pick(root: string, options: FolderPickerOptions): Promise<string[] | null> {
    const children = await this.listFolders(root, options);
    if (children.length === 0) {
      return [root];
    }
    return this.console.treeMultiSelectPrompt(
      options.message,
      this.treeOptions(root, children, options),
    );
  }

  private treeOptions(
    root: string,
    children: TreeNode<string>[],
    options: FolderPickerOptions,
  ): TreePromptOptions<string> {
    let allFolders: Promise<string[]> | undefined;
    return {
      roots: [
        {
          value: root,
          label: options.rootLabel ?? '.',
          detail: options.annotate?.(root),
          children,
        },
      ],
      loadChildren: (dir) => this.listFolders(dir, options),
      describe: (dir) => relative(root, dir).split(sep).join('/') || '.',
      search: async (query) => {
        // Listed once, on the first search, since it reads the whole folder tree.
        allFolders ??= listAllFolders(root);
        return this.searchResults(root, matchFolders(await allFolders, query), options);
      },
      noun: 'folders',
    };
  }

  /** The visible folders directly under `dir`, as tree nodes. */
  private async listFolders(
    dir: string,
    options: FolderPickerOptions,
  ): Promise<TreeNode<string>[]> {
    const names = await this.withoutIgnored(dir, await this.readSubfolderNames(dir));
    return Promise.all(
      names.map(async (name) => {
        const path = join(dir, name);
        const nested = await this.readSubfolderNames(path);
        return {
          value: path,
          label: name,
          detail: options.annotate?.(path),
          leaf: nested.length === 0,
        };
      }),
    );
  }

  private searchResults(
    root: string,
    matches: readonly string[],
    options: FolderPickerOptions,
  ): SearchResults<string> {
    return {
      options: matches.slice(0, MAX_SEARCH_RESULTS).map((folder) => {
        const path = join(root, folder);
        return { value: path, label: folder, detail: options.annotate?.(path) };
      }),
      total: matches.length,
    };
  }

  private async readSubfolderNames(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      logger.debug(`Could not list folders in ${dir}: ${(error as Error).message}`);
      return [];
    }
  }

  /** Drops the names git ignores in `dir`; outside a repository nothing is dropped. */
  private async withoutIgnored(dir: string, names: string[]): Promise<string[]> {
    if (names.length === 0) return names;
    // check-ignore exits 1 when nothing is ignored, which reads as `undefined` here.
    const ignored = await tryRunGitLines(['check-ignore', '--', ...names], dir);
    if (!ignored) return names;
    const skipped = new Set(ignored);
    return names.filter((name) => !skipped.has(name));
  }
}

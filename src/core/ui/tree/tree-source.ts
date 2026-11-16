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

// The tree prompt's model: what the tree is made of, as the caller supplies it.

import type { SearchResults } from '../console.ts';

export interface TreeNode<T> {
  value: T;
  label: string;
  /** Shown dimmed after the label (e.g. the project a folder is linked to). */
  detail?: string;
  /** Known to have no children, so it cannot be expanded. */
  leaf?: boolean;
  /** Children loaded up front; the node starts expanded. Otherwise they load on first expand. */
  children?: TreeNode<T>[];
}

export interface TreeSource<T> {
  roots: TreeNode<T>[];
  /** Runs on the first expand of a node without `children`. A rejection aborts the prompt and is rethrown. */
  loadChildren: (value: T) => Promise<TreeNode<T>[]>;
  /**
   * Searches the whole tree as the user types; the results replace the tree until the query is
   * cleared. Without it, typing does nothing. A rejection aborts the prompt and is rethrown.
   */
  search?: (query: string) => Promise<SearchResults<T>>;
}

export interface TreePromptOptions<T> extends TreeSource<T> {
  /** How the chosen value reads once submitted. Defaults to its label. */
  describe?: (value: T) => string;
  /** Plural noun for the search footer, e.g. `folders`. */
  noun?: string;
}

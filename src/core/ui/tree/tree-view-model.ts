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

// The tree prompt's view model: interaction state and the commands that change it, with no
// terminal behind it.

import type { SearchOption } from '../console.ts';
import type { SearchProgress } from '../search-prompt.ts';
import type { TreeNode, TreeSource } from './tree-source.ts';

const SEARCH_DEBOUNCE_MS = 100;

/** Runs `run` after `delayMs`; the returned function cancels it if it has not run yet. */
export type Scheduler = (run: () => void, delayMs: number) => () => void;

const timeoutScheduler: Scheduler = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

export type TreeMarker = 'expanded' | 'collapsed' | 'leaf' | 'loading';

/** One line of the list on screen: a tree row, or a search result. */
export interface TreeEntry {
  depth: number;
  /** Absent for search results, which cannot be expanded. */
  marker?: TreeMarker;
  /** Absent in a single-select tree, which has no checkboxes. */
  checked?: boolean;
  label: string;
  detail?: string;
  /** Text to highlight in the label: the query, for search results. */
  highlight?: string;
}

export interface TreeChoice<T> {
  value: T;
  label: string;
}

export interface TreeSnapshot<T> {
  multiple: boolean;
  /** Search results replace the tree while a query is typed. */
  searching: boolean;
  entries: TreeEntry[];
  cursor: number;
  /** Set while searching. */
  search?: SearchProgress;
  /** Ticked so far, in tick order; in a single-select tree, what the cursor is on. */
  chosen: TreeChoice<T>[];
  /** Enter was pressed in a multi-select tree with nothing ticked. */
  refused: boolean;
}

/** `empty`: there is nothing to submit; `loading`: the list is about to be replaced. */
export type SubmitOutcome<T> = { submitted: T[] } | { blocked: 'empty' | 'loading' };

export interface TreeViewModelOptions {
  multiple: boolean;
  /** Receives a rejected `loadChildren` or `search`. */
  onError: (error: unknown) => void;
  schedule?: Scheduler;
}

interface TreeRow<T> {
  node: TreeNode<T>;
  depth: number;
  parent: TreeRow<T> | undefined;
  /** `undefined` until the children are loaded. */
  children: TreeRow<T>[] | undefined;
  expanded: boolean;
  loading: boolean;
}

export class TreeViewModel<T> {
  private readonly roots: TreeRow<T>[];
  private cursorRow: TreeRow<T> | undefined;
  /** Ticked values with their labels, in the order they were ticked. */
  private readonly selection = new Map<T, string>();
  private query = '';
  private results: SearchOption<T>[] = [];
  private total = 0;
  private resultCursor = 0;
  private searchLoading = false;
  private searchLoaded = false;
  private refused = false;
  private disposed = false;
  // Bumped per search and on dispose, so a response that lost the race is dropped.
  private generation = 0;
  private cancelPending: (() => void) | undefined;
  private readonly listeners: (() => void)[] = [];
  private readonly schedule: Scheduler;

  constructor(
    private readonly source: TreeSource<T>,
    private readonly options: TreeViewModelOptions,
  ) {
    this.roots = this.toRows(source.roots, 0, undefined);
    this.cursorRow = this.roots.at(0);
    this.schedule = options.schedule ?? timeoutScheduler;
  }

  /** Called when state changes on its own, after children or search results arrive. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  moveBy(delta: number): void {
    this.refused = false;
    if (this.searching()) {
      const last = this.results.length - 1;
      this.resultCursor = Math.max(0, Math.min(last, this.resultCursor + delta));
      return;
    }
    const rows = this.visibleRows();
    if (rows.length === 0) return;
    const at = this.cursorRow ? rows.indexOf(this.cursorRow) : 0;
    this.cursorRow = rows[Math.max(0, Math.min(rows.length - 1, at + delta))];
  }

  /** Expands the row under the cursor, loading its children first, or steps into an expanded one. */
  expand(): void {
    this.refused = false;
    const row = this.cursorRow;
    if (this.searching() || !row || row.loading || !this.isExpandable(row)) return;
    if (row.children === undefined) {
      row.loading = true;
      this.loadChildren(row);
    } else if (row.expanded) {
      this.cursorRow = row.children.at(0);
    } else {
      row.expanded = true;
    }
  }

  /** Collapses the row under the cursor, or steps out to its parent when it is collapsed. */
  collapse(): void {
    this.refused = false;
    const row = this.cursorRow;
    if (this.searching() || !row) return;
    if (row.expanded) {
      row.expanded = false;
    } else if (row.parent) {
      this.cursorRow = row.parent;
    }
  }

  /** Ticks what the cursor is on, or unticks it; a no-op in a single-select tree. */
  toggle(): void {
    if (!this.options.multiple) return;
    this.refused = false;
    const choice = this.current();
    if (choice === undefined) return;
    if (this.selection.has(choice.value)) {
      this.selection.delete(choice.value);
    } else {
      this.selection.set(choice.value, choice.label);
    }
  }

  setQuery(query: string): void {
    if (query === this.query) return;
    this.query = query;
    this.restartSearch();
  }

  submit(): SubmitOutcome<T> {
    if (this.searching() && this.searchLoading) return { blocked: 'loading' };
    const submitted = this.chosen().map((choice) => choice.value);
    if (submitted.length === 0) {
      this.refused = this.options.multiple;
      return { blocked: 'empty' };
    }
    return { submitted };
  }

  snapshot(): TreeSnapshot<T> {
    const { multiple } = this.options;
    const checked = (value: T): boolean | undefined =>
      multiple ? this.selection.has(value) : undefined;
    const chosen = this.chosen();
    const refused = this.refused;
    if (this.searching()) {
      return {
        multiple,
        searching: true,
        entries: this.results.map((option) => ({
          depth: 0,
          checked: checked(option.value),
          label: option.label,
          detail: option.detail,
          highlight: this.query,
        })),
        cursor: this.resultCursor,
        search: {
          query: this.query,
          shown: this.results.length,
          total: this.total,
          loading: this.searchLoading,
          loaded: this.searchLoaded,
        },
        chosen,
        refused,
      };
    }
    const rows = this.visibleRows();
    return {
      multiple,
      searching: false,
      entries: rows.map((row) => ({
        depth: row.depth,
        marker: this.markerOf(row),
        checked: checked(row.node.value),
        label: row.node.label,
        detail: row.node.detail,
      })),
      cursor: this.cursorRow ? Math.max(0, rows.indexOf(this.cursorRow)) : 0,
      chosen,
      refused,
    };
  }

  /** Stops pending searches and drops results that arrive afterwards. */
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.cancelPending?.();
  }

  private searching(): boolean {
    return this.source.search !== undefined && this.query.trim().length > 0;
  }

  private current(): TreeChoice<T> | undefined {
    if (this.searching()) {
      const option = this.results.at(this.resultCursor);
      return option && { value: option.value, label: option.label };
    }
    const row = this.cursorRow;
    return row && { value: row.node.value, label: row.node.label };
  }

  private chosen(): TreeChoice<T>[] {
    if (this.options.multiple) {
      return [...this.selection].map(([value, label]) => ({ value, label }));
    }
    const current = this.current();
    return current ? [current] : [];
  }

  private restartSearch(): void {
    this.cancelPending?.();
    const id = ++this.generation;
    this.resultCursor = 0;
    const search = this.source.search;
    if (!this.searching() || search === undefined) {
      this.searchLoading = false;
      this.searchLoaded = false;
      this.results = [];
      return;
    }
    this.searchLoading = true;
    const query = this.query.trim();
    this.cancelPending = this.schedule(() => {
      search(query).then(
        (results) => {
          if (id !== this.generation) return;
          this.results = results.options;
          this.total = results.total;
          this.resultCursor = 0;
          this.searchLoading = false;
          this.searchLoaded = true;
          this.notify();
        },
        (error: unknown) => {
          if (id !== this.generation) return;
          this.options.onError(error);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
  }

  private loadChildren(row: TreeRow<T>): void {
    this.source.loadChildren(row.node.value).then(
      (children) => {
        if (this.disposed) return;
        row.loading = false;
        row.children = this.toRows(children, row.depth + 1, row);
        row.expanded = row.children.length > 0;
        this.notify();
      },
      (error: unknown) => {
        if (this.disposed) return;
        this.options.onError(error);
      },
    );
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private visibleRows(): TreeRow<T>[] {
    const rows: TreeRow<T>[] = [];
    const walk = (level: readonly TreeRow<T>[]): void => {
      for (const row of level) {
        rows.push(row);
        if (row.expanded && row.children) walk(row.children);
      }
    };
    walk(this.roots);
    return rows;
  }

  private isExpandable(row: TreeRow<T>): boolean {
    return !row.node.leaf && (row.children === undefined || row.children.length > 0);
  }

  private markerOf(row: TreeRow<T>): TreeMarker {
    if (row.loading) return 'loading';
    if (!this.isExpandable(row)) return 'leaf';
    return row.expanded ? 'expanded' : 'collapsed';
  }

  private toRows(
    nodes: readonly TreeNode<T>[],
    depth: number,
    parent: TreeRow<T> | undefined,
  ): TreeRow<T>[] {
    return nodes.map((node) => {
      const row: TreeRow<T> = {
        node,
        depth,
        parent,
        children: undefined,
        expanded: false,
        loading: false,
      };
      if (node.children) {
        row.children = this.toRows(node.children, depth + 1, row);
        row.expanded = row.children.length > 0;
      }
      return row;
    });
  }
}

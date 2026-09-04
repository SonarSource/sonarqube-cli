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

// Shared types for the UI module

export type ColorFn = (text: string) => string;

export type OutputChannel = 'stdout' | 'stderr';

export type StepStatus =
  | 'done' // ✓  green
  | 'running' // →  cyan
  | 'failed' // ✗  red
  | 'skipped' // ⏭  dim
  | 'warn' // ⚠  yellow
  | 'pending' // ○  dim
  | 'info'; // ℹ  cyan

export interface PhaseItem {
  text: string;
  status: StepStatus;
  detail?: string;
  /** Optional bullet sub-list rendered under the item (e.g. edited file paths). */
  subItems?: string[];
}

export function phaseItem(
  text: string,
  status: StepStatus,
  detail?: string,
  subItems?: string[],
): PhaseItem {
  return { text, status, detail, subItems };
}

export interface NoteOptions {
  borderColor?: ColorFn;
  titleColor?: ColorFn;
  contentColor?: ColorFn;
}

export interface PhaseOptions {
  titleColor?: ColorFn;
  iconColors?: Partial<Record<StepStatus, ColorFn>>;
}

export interface LogOptions {
  color?: ColorFn;
}

export interface SelectOption<T> {
  value: T;
  label: string;
}

export interface MultiSelectOption<T> {
  value: T;
  label: string;
  /** Shown but not toggleable (e.g. a repo that's already imported) — rendered like an at-cap row. */
  disabled?: boolean;
}

export interface MultiSelectPromptOptions<T> {
  /** True while more options can be revealed (e.g. a paginated collection's `hasMore`). */
  hasMore?: () => boolean;
  /**
   * Reveal more options, returning (or resolving to) the full updated list (existing options
   * plus newly revealed ones). May return a `Promise` when revealing more requires a network
   * call (e.g. `RepositoryCollection.loadMore`) — the "Load more" row shows a loading indicator
   * while it's in flight.
   */
  onLoadMore?: () => MultiSelectOption<T>[] | Promise<MultiSelectOption<T>[]>;
  /** Max number of selections. Defaults to 20; pass `Infinity` for no cap. */
  maxSelected?: number;
  /**
   * True total option count, for the "N/total selected" counter. Defaults to the currently
   * revealed `options.length`, which undercounts while paginated options remain unrevealed —
   * pass this when the caller's backing collection knows the real total up front (e.g.
   * `RepositoryCollection.length`).
   */
  total?: () => number;
}

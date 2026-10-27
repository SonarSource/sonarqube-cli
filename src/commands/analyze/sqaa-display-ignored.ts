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

// Rendering of the "Not analyzed" rows: one row per ignored file, collapsed per reason when large.

import { bold, dim, softBlue } from '@/core/ui/colors.ts';

import type { IgnoredFile } from './sqaa-changeset.ts';
import { formatIgnoredHeader } from './sqaa-display-headers.ts';

type IgnoredReason = IgnoredFile['reason'];

const IGNORED_REASON_LABELS: Record<IgnoredReason, string> = {
  binary: 'binary file',
  oversized: 'file too large',
  'outside-repository': 'outside the repository',
  'outside-project': 'not in a mapped project',
  'other-connection': 'project linked to another server or organization',
};

export function formatIgnoredLabel(reason: IgnoredReason): `[IGNORED: ${string}]` {
  return `[IGNORED: ${IGNORED_REASON_LABELS[reason]}]`;
}

function formatIgnoredCollapsedRow(count: number, reason: IgnoredReason, colored: boolean): string {
  const icon = colored ? dim('⊘') : '⊘';
  const countLabel = colored ? bold(String(count)) : String(count);
  const label = formatIgnoredLabel(reason);
  return `  ${icon}  ${countLabel} files  ${colored ? dim(label) : label}`;
}

function formatOutsideProjectHint(count: number, cdTarget: string, colored: boolean): string[] {
  const info = `${count} ${count === 1 ? 'file is' : 'files are'} not in a project mapped from this folder.`;
  const hint = ` Run from the repository root to include them: cd ${cdTarget} && sonar analyze agentic`;
  return colored
    ? [`  ${softBlue('ℹ')}  ${info}`, `  ${dim('→')} ${hint}`]
    : [`  ℹ  ${info}`, `  → ${hint}`];
}

export interface IgnoredLinesOptions {
  collapseThreshold: number;
  formatFileRow: (path: string, label: `[IGNORED: ${string}]`) => string;
  colored: boolean;
  /** Path from cwd to the repo root; enables the re-run hint for outside-project files. */
  repoRootFromCwd?: string;
}

/**
 * Ignored files as report rows. A reason with more than `collapseThreshold` files collapses to one
 * row at the position of its first file; other reasons keep one row per file. When
 * `repoRootFromCwd` is given and any file is outside every project, a re-run hint follows the rows and replaces
 * those files' own rows.
 */
function renderIgnoredRows(
  ignored: Array<{ path: string; reason: IgnoredReason }>,
  { collapseThreshold, formatFileRow, colored, repoRootFromCwd }: IgnoredLinesOptions,
): string[] {
  const countByReason = new Map<IgnoredReason, number>();
  for (const { reason } of ignored) {
    countByReason.set(reason, (countByReason.get(reason) ?? 0) + 1);
  }
  const collapsed = new Set<IgnoredReason>();
  const rows: string[] = [];
  for (const { path, reason } of ignored) {
    // The hint's count line stands in for these rows.
    if (repoRootFromCwd && reason === 'outside-project') continue;
    const count = countByReason.get(reason) ?? 0;
    if (count <= collapseThreshold) {
      rows.push(formatFileRow(path, formatIgnoredLabel(reason)));
    } else if (!collapsed.has(reason)) {
      collapsed.add(reason);
      rows.push(formatIgnoredCollapsedRow(count, reason, colored));
    }
  }
  const outsideProjectCount = countByReason.get('outside-project') ?? 0;
  if (repoRootFromCwd && outsideProjectCount > 0) {
    rows.push(...formatOutsideProjectHint(outsideProjectCount, repoRootFromCwd, colored));
  }
  return rows;
}

/**
 * The "Not analyzed" lines. Ignored files belong to no project, so under project headers (`grouped`)
 * they get their own section instead of reading as the last project's files.
 */
export function renderIgnoredLines(
  ignored: Array<{ path: string; reason: IgnoredReason }>,
  grouped: boolean,
  options: IgnoredLinesOptions,
): string[] {
  const rows = renderIgnoredRows(ignored, options);
  return grouped && ignored.length > 0
    ? ['', formatIgnoredHeader(ignored.length, options.colored), ...rows]
    : rows;
}

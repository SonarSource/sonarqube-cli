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

import { bold, dim } from '@/core/ui/colors.ts';

import type { IgnoredFile } from './sqaa-changeset.ts';

type IgnoredReason = IgnoredFile['reason'];

const IGNORED_REASON_LABELS: Record<IgnoredReason, string> = {
  binary: 'binary file',
  oversized: 'file too large',
  'outside-repository': 'outside the repository',
  'outside-project': 'not in a mapped project',
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

/**
 * Ignored files as report rows. A reason with more than `collapseThreshold` files collapses to one
 * row at the position of its first file; other reasons keep one row per file.
 */
export function renderIgnoredRows(
  ignored: Array<{ path: string; reason: IgnoredReason }>,
  collapseThreshold: number,
  formatFileRow: (path: string, label: `[IGNORED: ${string}]`) => string,
  colored: boolean,
): string[] {
  const countByReason = new Map<IgnoredReason, number>();
  for (const { reason } of ignored) {
    countByReason.set(reason, (countByReason.get(reason) ?? 0) + 1);
  }
  const collapsed = new Set<IgnoredReason>();
  const rows: string[] = [];
  for (const { path, reason } of ignored) {
    const count = countByReason.get(reason) ?? 0;
    if (count <= collapseThreshold) {
      rows.push(formatFileRow(path, formatIgnoredLabel(reason)));
    } else if (!collapsed.has(reason)) {
      collapsed.add(reason);
      rows.push(formatIgnoredCollapsedRow(count, reason, colored));
    }
  }
  return rows;
}

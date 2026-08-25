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

// Computes and applies column widths for terminal tables from actual cell content, so a table of
// short values stays compact while a table containing long values still aligns instead of
// truncating or running cells together.

/**
 * Each column's width is the longest cell it actually contains, or its floor from `minWidths`
 * (matched by index), whichever is larger. `minWidths` may be shorter than `columns` or omitted
 * entirely - missing floors default to 0.
 */
export function columnFormatting(columns: string[][], minWidths: number[] = []): number[] {
  return columns.map((column, i) =>
    Math.max(minWidths[i] ?? 0, ...column.map((value) => value.length)),
  );
}

/**
 * Pads every cell in each column to that column's computed width, so a row assembled by
 * concatenating (or joining) the same index across columns lines up regardless of content
 * length. Headers and any trailing unpadded column are left to the caller.
 *
 * `gap` adds extra trailing spaces on top of the computed width, applied to every column -
 * without it, the row containing a column's own longest cell always butts up directly against
 * whatever follows it, since padding that cell to its own width is a no-op. Callers that already
 * join columns with a visible separator (e.g. `' | '`) don't need this; callers that rely on
 * plain whitespace for separation do.
 */
export function padColumns(columns: string[][], minWidths: number[] = [], gap = 0): string[][] {
  const widths = columnFormatting(columns, minWidths);
  return columns.map((column, i) => column.map((value) => value.padEnd(widths[i] + gap)));
}

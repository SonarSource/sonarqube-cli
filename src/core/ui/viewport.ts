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

/**
 * The `[start, end)` rows of `total` to draw around `cursor`. A list longer than `viewportSize`
 * takes exactly `viewportSize` lines together with its "↑/↓ N more" lines, so it keeps its height
 * while scrolling, and each "more" line hides at least two rows (one would fit in its place).
 */
export function calculateViewport(
  cursor: number,
  total: number,
  viewportSize: number,
): { start: number; end: number } {
  if (total <= viewportSize) return { start: 0, end: total };
  const between = viewportSize - 2;
  const start = cursor - Math.floor(between / 2);
  if (start <= 1) return { start: 0, end: viewportSize - 1 };
  if (start + between >= total - 1) return { start: total - viewportSize + 1, end: total };
  return { start, end: start + between };
}

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

// Shared UI helpers for onboarding wizard steps

import { dim, green, red } from '../../../../ui/colors.js';

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

const LOC_BAR_WIDTH = 36;

/**
 * Build a single-line license-usage bar string (no printing). The filled
 * portion is green when `used` is within `total` and red when it exceeds it,
 * followed by the percentage and a `used / total lines` label. Used both for
 * the static post-analysis bar and the live selection bar.
 */
export function locBar(used: number, total: number): string {
  const safeTotal = Math.max(total, 1);
  const pct = Math.min(used / safeTotal, 1);
  const filledCount = Math.round(pct * LOC_BAR_WIDTH);
  const overCapacity = used > total;
  const fillColor = overCapacity ? red : green;
  const bar = fillColor('█'.repeat(filledCount)) + dim('░'.repeat(LOC_BAR_WIDTH - filledCount));
  const pctLabel = `${Math.round((used / safeTotal) * 100)}%`;
  const locLabel = dim(`${formatNumber(used)} / ${formatNumber(total)} lines`);
  return `  ${bar}  ${pctLabel}  ${locLabel}`;
}

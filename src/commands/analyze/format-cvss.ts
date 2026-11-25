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

export const CVSS_SCORE_WIDTH = 'X.Y'.length;
const CVSS_PREFIX = 'CVSS ';

export function compactCvssScore(score: string): string {
  return score === '10.0' ? '10' : score;
}

export function formatCvssPrefix(score: string | null, width = CVSS_SCORE_WIDTH): string {
  return score === null
    ? ' '.repeat(CVSS_PREFIX.length + width)
    : `${CVSS_PREFIX}${compactCvssScore(score).padStart(width)}`;
}

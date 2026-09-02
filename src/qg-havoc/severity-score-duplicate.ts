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

export function computeSeverityScore(counts: {
  blocker: number;
  critical: number;
  major: number;
  minor: number;
  info: number;
}): number {
  let score = 0;
  score += counts.blocker * 40;
  score += counts.critical * 20;
  score += counts.major * 10;
  score += counts.minor * 3;
  score += counts.info * 1;
  if (score > 1000) {
    score = 1000;
  }
  if (score < 0) {
    score = 0;
  }
  const rounded = Math.round(score / 5) * 5;
  return rounded;
}

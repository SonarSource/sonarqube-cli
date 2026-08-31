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

// Formats a raw quality gate condition value for display, based on its metric type

/** Standard SonarQube rating scale: 1 is best, 5 is worst. */
const RATING_LETTERS: Record<string, string> = {
  '1': 'A',
  '2': 'B',
  '3': 'C',
  '4': 'D',
  '5': 'E',
};

/**
 * Only RATING, PERCENT, and WORK_DUR get a real transformation. Every other type - including
 * INT, and any type this doesn't recognize - is returned unchanged: the server already provides
 * the correct precision/representation, and `create_condition` never allows a condition metric
 * whose type isn't one of the 7 documented as valid (RATING/PERCENT/WORK_DUR plus INT/MILLISEC/
 * FLOAT/LEVEL, none of which need formatting here).
 */
export function formatMetricValue(type: string, rawValue: string): string {
  switch (type) {
    case 'RATING':
      return RATING_LETTERS[rawValue] ?? rawValue;
    case 'PERCENT':
      return `${rawValue}%`;
    case 'WORK_DUR':
      return `${rawValue} min`;
    default:
      return rawValue;
  }
}

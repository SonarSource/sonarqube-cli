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

import type { Severity } from '../../sca-scanner.ts';
import { type RiskVM } from '../risk.ts';

const SEVERITY_RANK: Record<Severity, number> = {
  BLOCKER: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
};

export const SEVERITIES = Object.keys(SEVERITY_RANK) as Severity[];

export function severityRank(severity: Severity): number {
  const ranks: Partial<Record<Severity, number>> = SEVERITY_RANK;
  return ranks[severity] ?? Number.MAX_SAFE_INTEGER;
}

export function compareSeverity(a: Severity, b: Severity): number {
  return severityRank(a) - severityRank(b);
}

export function sortBySeverity<T extends RiskVM>(items: T[]): T[] {
  return [...items].sort((a, b) => compareSeverity(a.severity, b.severity));
}

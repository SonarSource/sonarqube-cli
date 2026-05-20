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

import type { ScaIssueType, Severity } from '../../sca-scanner.ts';
import type { PackageVM } from '../package.ts';
import type { RiskVM } from '../risk.ts';
import type { SummaryVM } from '../summary.ts';
import { compareSeverity } from './severity.ts';

export function buildSummaryVM(packages: PackageVM[], packagesScanned: number): SummaryVM {
  return {
    packagesScanned,
    totalRisks: packages.reduce((n, p) => n + p.riskCount, 0),
    byType: countsByTypeAndSeverity(packages),
  };
}

function countsByTypeAndSeverity(packages: PackageVM[]): Map<ScaIssueType, Map<Severity, number>> {
  const byType = new Map<ScaIssueType, Map<Severity, number>>();
  for (const pkg of packages) {
    for (const group of pkg.groups) {
      addRiskCounts(getOrCreateRow(byType, group.type), group.risks);
    }
  }
  for (const row of byType.values()) sortBySeverityInPlace(row);
  return byType;
}

function getOrCreateRow(
  byType: Map<ScaIssueType, Map<Severity, number>>,
  type: ScaIssueType,
): Map<Severity, number> {
  let row = byType.get(type);
  if (row === undefined) {
    row = new Map<Severity, number>();
    byType.set(type, row);
  }
  return row;
}

function addRiskCounts(row: Map<Severity, number>, risks: RiskVM[]): void {
  for (const risk of risks) {
    row.set(risk.severity, (row.get(risk.severity) ?? 0) + 1);
  }
}

function sortBySeverityInPlace(row: Map<Severity, number>): void {
  const sorted = [...row.entries()].sort(([a], [b]) => compareSeverity(a, b));
  row.clear();
  for (const [sev, count] of sorted) row.set(sev, count);
}

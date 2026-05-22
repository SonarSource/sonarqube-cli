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

import type { RiskFilterDescription } from '../../risk-filter.ts';
import type { ScaIssueType, Severity } from '../../sca-scanner.ts';
import type { PackageVM } from '../package.ts';
import type { RiskVM } from '../risk.ts';
import type { PackageSummaryVM, SummaryVM } from '../summary.ts';
import { ISSUE_TYPES } from './issue-types.ts';
import { compareSeverity, SEVERITIES } from './severity.ts';

export function buildSummaryVM(
  packages: PackageVM[],
  packagesScanned: number,
  filter: RiskFilterDescription,
): SummaryVM {
  return {
    packagesScanned,
    totalRisks: packages.reduce((n, p) => n + p.riskCount, 0),
    byType: countsByTypeAndSeverity(packages),
    packages: packages.map(toPackageSummary),
    filter,
  };
}

function toPackageSummary(pkg: PackageVM): PackageSummaryVM {
  return {
    package: pkg.package,
    riskCount: pkg.riskCount,
    highestSeverity: highestSeverityOf(pkg),
    recommendations: new Map(pkg.groups.map((g) => [g.type, g.recommendation])),
  };
}

function highestSeverityOf(pkg: PackageVM): Severity {
  let highest: Severity | undefined;
  for (const group of pkg.groups) {
    for (const risk of group.selectedRisks) {
      if (highest === undefined || compareSeverity(risk.severity, highest) < 0) {
        highest = risk.severity;
      }
    }
  }
  if (highest === undefined) {
    throw new Error(`Package ${pkg.package.label()} has no risks`);
  }
  return highest;
}

function countsByTypeAndSeverity(packages: PackageVM[]): Map<ScaIssueType, Map<Severity, number>> {
  const byType = new Map<ScaIssueType, Map<Severity, number>>(
    ISSUE_TYPES.map((type) => [type, new Map(SEVERITIES.map((sev) => [sev, 0]))]),
  );
  for (const pkg of packages) {
    for (const group of pkg.groups) {
      addRiskCounts(byType.get(group.type)!, group.selectedRisks);
    }
  }
  return byType;
}

function addRiskCounts(row: Map<Severity, number>, risks: RiskVM[]): void {
  for (const risk of risks) {
    row.set(risk.severity, (row.get(risk.severity) ?? 0) + 1);
  }
}

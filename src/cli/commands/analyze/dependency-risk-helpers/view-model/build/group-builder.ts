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

import type { RiskPredicate } from '../../risk-filter.ts';
import type {
  AnalyzeProjectIssue,
  AnalyzeProjectRelease,
  ScaIssueType,
} from '../../sca-scanner.ts';
import type {
  LicenseGroupVM,
  MalwareGroupVM,
  RiskGroupVM,
  RiskVM,
  VulnerabilityGroupVM,
} from '../risk.ts';
import { selectPackageCompleteFixes } from './fix-version-selector.ts';
import { ISSUE_TYPES } from './issue-types.ts';
import {
  buildLicenseRecommendation,
  buildMalwareRecommendation,
  buildVulnerabilityRecommendation,
} from './recommendation-builder.ts';
import { buildLicenseRisk, buildMalwareRisk, buildVulnerabilityRisk } from './risk-builder.ts';
import { sortBySeverity } from './severity.ts';

export function buildGroups(
  release: AnalyzeProjectRelease,
  filter: RiskPredicate,
): RiskGroupVM<RiskVM>[] {
  const byType = groupIssuesByType(release.issues);
  const groups: RiskGroupVM<RiskVM>[] = [];
  for (const type of ISSUE_TYPES) {
    const typed = byType.get(type) ?? [];
    if (typed.length === 0) continue;
    const group = buildGroup(type, release, sortBySeverity(typed), filter);
    if (group !== null) groups.push(group);
  }
  return groups;
}

function groupIssuesByType(
  issues: AnalyzeProjectIssue[],
): Map<ScaIssueType, AnalyzeProjectIssue[]> {
  const byType = new Map<ScaIssueType, AnalyzeProjectIssue[]>();
  for (const type of ISSUE_TYPES) byType.set(type, []);
  for (const issue of issues) byType.get(issue.type)?.push(issue);
  return byType;
}

function buildGroup(
  type: ScaIssueType,
  release: AnalyzeProjectRelease,
  issues: AnalyzeProjectIssue[],
  filter: RiskPredicate,
): MalwareGroupVM | LicenseGroupVM | VulnerabilityGroupVM | null {
  switch (type) {
    case 'MALWARE': {
      const risks = filterRisks(
        issues.map((i) => buildMalwareRisk(release, i)),
        filter,
      );
      if (risks.length === 0) return null;
      return { type, risks, recommendation: buildMalwareRecommendation() };
    }
    case 'PROHIBITED_LICENSE': {
      const risks = filterRisks(
        issues.map((i) => buildLicenseRisk(release, i)),
        filter,
      );
      if (risks.length === 0) return null;
      return { type, risks, recommendation: buildLicenseRecommendation() };
    }
    case 'VULNERABILITY': {
      const survivors = issues
        .map((issue) => ({ issue, risk: buildVulnerabilityRisk(release, issue) }))
        .filter(({ risk }) => filter(risk));
      if (survivors.length === 0) return null;
      const fixVersions = selectPackageCompleteFixes(survivors.map(({ issue }) => issue));
      return {
        type,
        risks: survivors.map(({ risk }) => risk),
        recommendation: buildVulnerabilityRecommendation(fixVersions),
      };
    }
  }
}

function filterRisks<T extends RiskVM>(risks: T[], filter: RiskPredicate): T[] {
  return risks.filter(filter);
}

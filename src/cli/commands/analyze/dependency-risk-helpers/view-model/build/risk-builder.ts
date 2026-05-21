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

import type { AnalyzeProjectIssue, AnalyzeProjectRelease } from '../../sca-scanner.ts';
import type {
  EffectiveStatus,
  LicenseRiskVM,
  MalwareRiskVM,
  VulnerabilityRiskVM,
} from '../risk.ts';
import { selectIssuePartialFixes } from './fix-version-selector.ts';

export function buildMalwareRisk(
  release: AnalyzeProjectRelease,
  issue: AnalyzeProjectIssue,
): MalwareRiskVM {
  return {
    severity: issue.severity,
    status: effectiveStatus(release, issue),
  };
}

export function buildLicenseRisk(
  release: AnalyzeProjectRelease,
  issue: AnalyzeProjectIssue,
): LicenseRiskVM {
  return {
    severity: issue.severity,
    status: effectiveStatus(release, issue),
    spdxLicenseId: issue.spdxLicenseId,
    releaseLicenseExpression: release.licenseExpression,
  };
}

export function buildVulnerabilityRisk(
  release: AnalyzeProjectRelease,
  issue: AnalyzeProjectIssue,
): VulnerabilityRiskVM {
  return {
    severity: issue.severity,
    status: effectiveStatus(release, issue),
    cvssScore: issue.cvssScore,
    vulnerabilityId: issue.vulnerabilityId ?? '',
    partialFixes: selectIssuePartialFixes(issue),
  };
}

function effectiveStatus(
  release: Pick<AnalyzeProjectRelease, 'newlyIntroduced'>,
  issue: Pick<AnalyzeProjectIssue, 'status'>,
): EffectiveStatus {
  const fallback: EffectiveStatus = release.newlyIntroduced ? 'NEW' : 'OPEN';
  return issue.status ?? fallback;
}

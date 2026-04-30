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

import { sortReleases } from './analysis-response.ts';
import type {
  AnalysisErrorResource,
  AnalyzeProjectIssue,
  AnalyzeProjectRelease,
  AnalyzeProjectResponse,
  VersionOptionDescriptionCode,
} from './sca-scanner.ts';

const DESCRIPTION_CODE_ORDER: Record<VersionOptionDescriptionCode, number> = {
  LATEST_STABLE: 0,
  LATEST_COMPLETE: 1,
  LATEST_PRERELEASE: 2,
  LATEST_PARTIAL: 3,
  NEAREST_COMPLETE: 4,
  NEAREST_PARTIAL: 5,
  VERSION_IN_USE: 6,
  UNKNOWN: 7,
};

const EXCLUDED_DESCRIPTION_CODES: ReadonlySet<VersionOptionDescriptionCode> = new Set([
  'VERSION_IN_USE',
  'UNKNOWN',
]);

const SEVERITY_WIDTH = 9;
const STATUS_WIDTH = 8;
const SEPARATOR_WIDTH = 70;
const MAX_CHAINS_DISPLAYED = 3;

export function formatDependencyRisksTable(
  filtered: AnalyzeProjectResponse,
  allReleases: AnalyzeProjectRelease[],
): string {
  const releaseByPurl = new Map(allReleases.map((r) => [r.packageUrl, r]));
  const displayedReleases = sortReleases(filtered.releases);
  const errors = filtered.errors;
  const packagesScanned = allReleases.length;

  const totalRisks = displayedReleases.reduce((n, release) => n + release.issues.length, 0);
  const lines: string[] = [
    `Scan Summary: ${packagesScanned} dependencies checked. ${totalRisks} risks found`,
  ];

  if (totalRisks === 0) {
    if (errors.length === 0) {
      lines.push('No dependency risks found.');
    } else {
      appendErrors(lines, errors);
    }
    return lines.join('\n');
  }

  for (const release of displayedReleases) {
    if (release.issues.length === 0) continue;
    lines.push('', packageHeader(release));
    if (release.dependencyFilePaths.length > 0) {
      lines.push(`in: ${release.dependencyFilePaths.join(', ')}`);
    }
    for (const line of transitiveChainLines(release.dependencyChains, releaseByPurl)) {
      lines.push(line);
    }

    lines.push('');
    for (const issue of release.issues) {
      lines.push(issueLine(release, issue));
    }
  }

  lines.push('', '═'.repeat(SEPARATOR_WIDTH));
  appendErrors(lines, errors);

  return lines.join('\n');
}

function getLabel(release: AnalyzeProjectRelease): string {
  return `${release.packageName}@${release.version}`;
}

function packageHeader(release: AnalyzeProjectRelease): string {
  const baseName = getLabel(release);
  const name = release.newlyIntroduced ? `${baseName} [NEW]` : baseName;
  const count = release.issues.length;
  const label = `── ${name} (${count} risk${count === 1 ? '' : 's'}) `;
  if (label.length >= SEPARATOR_WIDTH) {
    return `${label}─`;
  }
  return label + '─'.repeat(SEPARATOR_WIDTH - label.length);
}

function issueLine(release: AnalyzeProjectRelease, issue: AnalyzeProjectIssue): string {
  const severity = issue.severity.toUpperCase().padEnd(SEVERITY_WIDTH);
  const fallback = release.newlyIntroduced ? 'NEW' : 'OPEN';
  const status = (issue.status ?? fallback).toUpperCase().padEnd(STATUS_WIDTH);
  const issueText = issueCell(release, issue);
  const remediation = remediationCell(issue);
  const detail = remediation ? `${issueText} → ${remediation}` : issueText;
  return `${severity} ${status} ${detail}`;
}

function appendErrors(lines: string[], errors: AnalysisErrorResource[]): void {
  if (errors.length === 0) {
    return;
  }
  lines.push('', 'Errors:');
  for (const err of errors) {
    const prefix = `  [${err.code}]`;
    lines.push(err.path ? `${prefix} ${err.path}: ${err.message}` : `${prefix} ${err.message}`);
  }
}

function issueCell(release: AnalyzeProjectRelease, issue: AnalyzeProjectIssue): string {
  switch (issue.type) {
    case 'VULNERABILITY':
      return issue.vulnerabilityId ?? '';
    case 'PROHIBITED_LICENSE':
      return issue.spdxLicenseId ?? release.licenseExpression ?? '';
    case 'MALWARE':
      return 'Malicious package';
  }
}

function remediationCell(issue: AnalyzeProjectIssue): string {
  switch (issue.type) {
    case 'MALWARE':
      return 'Remove dependency';
    case 'PROHIBITED_LICENSE':
      return 'Review usage';
    case 'VULNERABILITY':
      return chooseUpgradeRemediation(issue);
  }
}

function chooseUpgradeRemediation(issue: AnalyzeProjectIssue): string {
  const options = issue.versionOptions;
  if (!options || options.length === 0) {
    return '';
  }

  const sorted = options.filter(
    (option) =>
      option.fixLevel !== 'NONE' && !EXCLUDED_DESCRIPTION_CODES.has(option.descriptionCode),
  );
  sorted.sort(
    (a, b) => DESCRIPTION_CODE_ORDER[a.descriptionCode] - DESCRIPTION_CODE_ORDER[b.descriptionCode],
  );
  const top = sorted.slice(0, 3);

  if (top.length === 0) {
    return '';
  }

  const fixes = top.map((option) => `${option.version} (${option.fixLevel.toLowerCase()} fix)`);
  return `Change version to ${fixes.join(' | ')}`;
}

function transitiveChainLines(
  chains: string[][],
  releaseByPurl: Map<string, AnalyzeProjectRelease>,
): string[] {
  if (chains.length === 0) {
    return [];
  }
  const shortest = [...chains].sort((a, b) => a.length - b.length).slice(0, MAX_CHAINS_DISPLAYED);
  const lines = shortest.map((chain) => {
    const labels = chain.map((purl) => {
      const release = releaseByPurl.get(purl);
      return release ? getLabel(release) : purl;
    });
    return `via ${labels.join(' → ')}`;
  });
  const remaining = chains.length - shortest.length;
  if (remaining > 0) {
    lines.push(`and via ${remaining} others`);
  }
  return lines;
}

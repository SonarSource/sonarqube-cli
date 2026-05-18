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
const MAX_LINE_WIDTH = 80;
const MAX_CHAINS_DISPLAYED = 3;
const MAX_ISSUES_DISPLAYED = 3;
const REMEDIATION_INDENT = ' '.repeat(SEVERITY_WIDTH + 1 + STATUS_WIDTH + 1);
const CHAIN_CONTINUATION_INDENT = '    ';

const SEVERITY_ORDER = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;

export function formatDependencyRisksTable(
  filtered: AnalyzeProjectResponse,
  allReleases: AnalyzeProjectRelease[],
): string {
  const releaseByPurl = new Map(allReleases.map((r) => [r.packageUrl, r]));
  const displayedReleases = sortReleases(filtered.releases);
  const errors = filtered.errors;
  const totalRisks = countTotalRisks(displayedReleases);

  const lines: string[] = [summaryLine(allReleases.length, totalRisks)];

  if (totalRisks > 0) {
    appendReleases(displayedReleases, lines, releaseByPurl);
  } else {
    appendNoRisksTail(lines);
  }

  lines.push('', '═'.repeat(MAX_LINE_WIDTH));
  appendErrors(lines, errors);

  return lines.join('\n');
}

function countTotalRisks(releases: AnalyzeProjectRelease[]): number {
  return releases.reduce((n, release) => n + release.issues.length, 0);
}

function summaryLine(packagesScanned: number, totalRisks: number): string {
  return `Scan Summary: ${packagesScanned} dependencies checked. ${totalRisks} risks found`;
}

function appendNoRisksTail(lines: string[]): void {
  lines.push('No dependency risks found.');
}

function appendReleases(
  displayedReleases: AnalyzeProjectRelease[],
  lines: string[],
  releaseByPurl: Map<string, AnalyzeProjectRelease>,
) {
  for (const release of displayedReleases) {
    if (release.issues.length === 0) continue;
    appendReleaseBlock(lines, release, releaseByPurl);
  }
}

function appendReleaseBlock(
  lines: string[],
  release: AnalyzeProjectRelease,
  releaseByPurl: Map<string, AnalyzeProjectRelease>,
): void {
  lines.push('', packageHeader(release));
  if (release.dependencyFilePaths.length > 0) {
    lines.push(`in: ${release.dependencyFilePaths.join(', ')}`);
  }
  for (const line of transitiveChainLines(release.dependencyChains, releaseByPurl)) {
    lines.push(line);
  }
  lines.push('');
  appendIssuesBlock(lines, release);
}

function appendIssuesBlock(lines: string[], release: AnalyzeProjectRelease): void {
  const visibleIssues = release.issues.slice(0, MAX_ISSUES_DISPLAYED);
  for (const issue of visibleIssues) {
    for (const line of issueLines(release, issue)) {
      lines.push(line);
    }
  }
  const hiddenIssues = release.issues.slice(visibleIssues.length);
  if (hiddenIssues.length > 0) {
    lines.push(
      `${REMEDIATION_INDENT}... and ${hiddenIssues.length} more risks${formatHiddenSeverityBreakdown(hiddenIssues)}`,
    );
  }
}

function getLabel(release: AnalyzeProjectRelease): string {
  return `${release.packageName}@${release.version}`;
}

function packageHeader(release: AnalyzeProjectRelease): string {
  const baseName = getLabel(release);
  const name = release.newlyIntroduced ? `${baseName} [NEW]` : baseName;
  const count = release.issues.length;
  const label = `── ${name} (${count} risk${count === 1 ? '' : 's'}) `;
  if (label.length >= MAX_LINE_WIDTH) {
    return `${label}─`;
  }
  return label + '─'.repeat(MAX_LINE_WIDTH - label.length);
}

function issueLines(release: AnalyzeProjectRelease, issue: AnalyzeProjectIssue): string[] {
  const severity = issue.severity.toUpperCase().padEnd(SEVERITY_WIDTH);
  const fallback = release.newlyIntroduced ? 'NEW' : 'OPEN';
  const status = (issue.status ?? fallback).toUpperCase().padEnd(STATUS_WIDTH);
  const issueText = issueCell(release, issue);
  const out = [`${severity} ${status} ${issueText}`];
  const remediation = remediationCell(issue);
  if (remediation) {
    for (const line of wrapRemediation(remediation, REMEDIATION_INDENT, MAX_LINE_WIDTH)) {
      out.push(line);
    }
  }
  return out;
}

function wrapRemediation(text: string, indent: string, maxWidth: number): string[] {
  const parts = text.split(' | ');
  const fragments = parts.map((part, idx) => (idx === 0 ? part : `| ${part}`));
  const lines: string[] = [];
  let current = '';
  for (const fragment of fragments) {
    if (current === '') {
      current = fragment;
      continue;
    }
    const candidate = `${current} ${fragment}`;
    if (indent.length + candidate.length <= maxWidth) {
      current = candidate;
    } else {
      lines.push(`${indent}${current}`);
      current = fragment;
    }
  }
  if (current !== '') {
    lines.push(`${indent}${current}`);
  }
  return lines;
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

function formatHiddenSeverityBreakdown(hidden: AnalyzeProjectIssue[]): string {
  const counts = new Map<string, number>();
  for (const issue of hidden) {
    const sev = issue.severity.toUpperCase();
    counts.set(sev, (counts.get(sev) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const sev of SEVERITY_ORDER) {
    const n = counts.get(sev);
    if (n) parts.push(`${n} ${sev}`);
  }
  for (const [sev, n] of counts) {
    if (!SEVERITY_ORDER.includes(sev as (typeof SEVERITY_ORDER)[number]) && n > 0) {
      parts.push(`${n} ${sev}`);
    }
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function transitiveChainLines(
  chains: string[][],
  releaseByPurl: Map<string, AnalyzeProjectRelease>,
): string[] {
  if (chains.length === 0) {
    return [];
  }
  const shortest = [...chains].sort((a, b) => a.length - b.length).slice(0, MAX_CHAINS_DISPLAYED);
  const lines: string[] = [];
  for (const chain of shortest) {
    const labels = chain.map((purl) => {
      const release = releaseByPurl.get(purl);
      return release ? getLabel(release) : purl;
    });
    for (const line of wrapChain(labels, MAX_LINE_WIDTH)) {
      lines.push(line);
    }
  }
  const remaining = chains.length - shortest.length;
  if (remaining > 0) {
    lines.push(`and via ${remaining} others`);
  }
  return lines;
}

function wrapChain(labels: string[], maxWidth: number): string[] {
  if (labels.length === 0) {
    return ['via '];
  }
  const lines: string[] = [];
  let current = `via ${labels[0]}`;
  for (let i = 1; i < labels.length; i++) {
    const candidate = `${current} → ${labels[i]}`;
    if (candidate.length <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = `${CHAIN_CONTINUATION_INDENT}→ ${labels[i]}`;
    }
  }
  lines.push(current);
  return lines;
}

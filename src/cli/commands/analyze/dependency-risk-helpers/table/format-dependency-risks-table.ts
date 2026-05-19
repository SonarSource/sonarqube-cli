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

import { dim, green, red, STATUS_ICONS } from '../../../../../ui/colors.js';
import { sortReleases } from '../analysis-response.ts';
import type {
  AnalysisErrorResource,
  AnalyzeProjectIssue,
  AnalyzeProjectRelease,
  AnalyzeProjectResponse,
  ScaIssueType,
} from '../sca-scanner.ts';
import { appendLicenseGroup } from './format-table-license-group.ts';
import { appendMalwareGroup } from './format-table-malware-group.ts';
import { appendVulnerabilityGroup } from './format-table-vulnerability-group.ts';

const MAX_LINE_WIDTH = 80;
const MAX_CHAINS_DISPLAYED = 3;
const CHAIN_LINE_INDENT = '  ';
const CHAIN_CONTINUATION_INDENT = `${CHAIN_LINE_INDENT}    `;

const ISSUE_TYPES: ScaIssueType[] = ['MALWARE', 'PROHIBITED_LICENSE', 'VULNERABILITY'];
const SEVERITIES = ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
const TYPE_LABEL_WIDTH = 'PROHIBITED_LICENSE'.length;

export function formatDependencyRisksTable(
  filtered: AnalyzeProjectResponse,
  allReleases: AnalyzeProjectRelease[],
): string {
  const releaseByPurl = new Map(allReleases.map((r) => [r.packageUrl, r]));
  const displayedReleases = sortReleases(filtered.releases);
  const errors = filtered.errors;
  const totalRisks = countTotalRisks(displayedReleases);

  const lines: string[] = [];

  if (totalRisks > 0) {
    appendReleases(displayedReleases, lines, releaseByPurl);
  } else {
    appendNoRisksTail(lines);
  }

  lines.push('', '═'.repeat(MAX_LINE_WIDTH));
  appendErrors(lines, errors);
  appendSummaryBlock(lines, displayedReleases, allReleases.length, totalRisks);

  return lines.join('\n');
}

function countTotalRisks(releases: AnalyzeProjectRelease[]): number {
  return releases.reduce((n, release) => n + release.issues.length, 0);
}

function summaryHeader(packagesScanned: number, totalRisks: number): string {
  return `Summary: ${packagesScanned} dependencies checked, ${totalRisks} risks found`;
}

function appendNoRisksTail(lines: string[]): void {
  lines.push('No dependency risks found.');
}

function appendReleases(
  displayedReleases: AnalyzeProjectRelease[],
  lines: string[],
  releaseByPurl: Map<string, AnalyzeProjectRelease>,
): void {
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
  if (lines.length > 0) lines.push('');
  lines.push(packageHeader(release));
  if (release.dependencyFilePaths.length > 0) {
    lines.push(`in: ${release.dependencyFilePaths.join(', ')}`);
  }
  for (const line of transitiveChainLines(release.dependencyChains, releaseByPurl)) {
    lines.push(dim(line));
  }
  lines.push('');
  appendIssuesBlock(lines, release);
}

function appendIssuesBlock(lines: string[], release: AnalyzeProjectRelease): void {
  const byType = new Map<ScaIssueType, AnalyzeProjectIssue[]>();
  for (const type of ISSUE_TYPES) byType.set(type, []);
  for (const issue of release.issues) byType.get(issue.type)?.push(issue);

  let firstGroupEmitted = false;
  for (const type of ISSUE_TYPES) {
    const issues = byType.get(type) ?? [];
    if (issues.length === 0) continue;
    if (firstGroupEmitted) lines.push('');
    emitGroup(lines, release, type, issues);
    firstGroupEmitted = true;
  }
}

function emitGroup(
  lines: string[],
  release: AnalyzeProjectRelease,
  type: ScaIssueType,
  issues: AnalyzeProjectIssue[],
): void {
  switch (type) {
    case 'MALWARE':
      appendMalwareGroup(lines, release, issues);
      return;
    case 'PROHIBITED_LICENSE':
      appendLicenseGroup(lines, release, issues);
      return;
    case 'VULNERABILITY':
      appendVulnerabilityGroup(lines, release, issues);
      return;
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

function appendSummaryBlock(
  lines: string[],
  releases: AnalyzeProjectRelease[],
  packagesScanned: number,
  totalRisks: number,
): void {
  const counts = summaryCountsByTypeAndSeverity(releases);
  lines.push('', summaryHeader(packagesScanned, totalRisks));
  for (const type of ISSUE_TYPES) {
    lines.push(summaryLineForType(type, counts.get(type) ?? new Map()));
  }
}

function summaryCountsByTypeAndSeverity(
  releases: AnalyzeProjectRelease[],
): Map<ScaIssueType, Map<string, number>> {
  const out = new Map<ScaIssueType, Map<string, number>>();
  for (const type of ISSUE_TYPES) {
    const row = new Map<string, number>();
    for (const sev of SEVERITIES) row.set(sev, 0);
    out.set(type, row);
  }
  for (const release of releases) {
    for (const issue of release.issues) {
      const row = out.get(issue.type);
      if (!row) continue;
      const sev = issue.severity.toUpperCase();
      if (!row.has(sev)) continue;
      row.set(sev, (row.get(sev) ?? 0) + 1);
    }
  }
  return out;
}

function summaryLineForType(type: ScaIssueType, counts: Map<string, number>): string {
  const cells = SEVERITIES.map((sev) => summarySeverityCell(sev, counts.get(sev) ?? 0));
  return `  ${type.padEnd(TYPE_LABEL_WIDTH)}  ${cells.join('    ')}`;
}

function summarySeverityCell(label: string, count: number): string {
  const icon = count === 0 ? green(STATUS_ICONS.done) : red(STATUS_ICONS.failed);
  return `${label} ${icon} ${String(count).padStart(3)}`;
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
    lines.push(`${CHAIN_LINE_INDENT}and via ${remaining} others`);
  }
  return lines;
}

function wrapChain(labels: string[], maxWidth: number): string[] {
  if (labels.length === 0) {
    return [`${CHAIN_LINE_INDENT}via `];
  }
  const lines: string[] = [];
  let current = `${CHAIN_LINE_INDENT}via ${labels[0]}`;
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

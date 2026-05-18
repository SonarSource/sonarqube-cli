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
  VersionOption,
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
const MAX_PACKAGE_FIXES = 2;
const CHAIN_CONTINUATION_INDENT = '    ';

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
  lines.push('', packageHeader(release));
  if (release.dependencyFilePaths.length > 0) {
    lines.push(`in: ${release.dependencyFilePaths.join(', ')}`);
  }
  for (const line of transitiveChainLines(release.dependencyChains, releaseByPurl)) {
    lines.push(line);
  }
  const fixLine = packageFixLine(release);
  if (fixLine !== null) {
    lines.push(fixLine);
  }
  lines.push('');
  appendIssuesBlock(lines, release);
}

function appendIssuesBlock(lines: string[], release: AnalyzeProjectRelease): void {
  for (const issue of release.issues) {
    lines.push(issueLine(release, issue));
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

function issueLine(release: AnalyzeProjectRelease, issue: AnalyzeProjectIssue): string {
  const severity = issue.severity.toUpperCase().padEnd(SEVERITY_WIDTH);
  const fallback = release.newlyIntroduced ? 'NEW' : 'OPEN';
  const status = (issue.status ?? fallback).toUpperCase().padEnd(STATUS_WIDTH);
  const cell = issueCell(release, issue);
  const inline = inlineRemediation(issue);
  const tail = inline ? ` → ${inline}` : '';
  return `${severity} ${status} ${cell}${tail}`;
}

function inlineRemediation(issue: AnalyzeProjectIssue): string | null {
  switch (issue.type) {
    case 'MALWARE':
      return 'Remove dependency';
    case 'PROHIBITED_LICENSE':
      return 'Review usage';
    case 'VULNERABILITY': {
      const partial = chooseInlinePartialFix(issue);
      return partial ? `${partial.version} (partial fix)` : null;
    }
  }
}

function chooseInlinePartialFix(issue: AnalyzeProjectIssue): VersionOption | null {
  const options = issue.versionOptions;
  if (!options || options.length === 0) {
    return null;
  }
  const partials = options.filter(
    (o) => o.fixLevel === 'PARTIAL' && !EXCLUDED_DESCRIPTION_CODES.has(o.descriptionCode),
  );
  if (partials.length === 0) {
    return null;
  }
  partials.sort(
    (a, b) => DESCRIPTION_CODE_ORDER[a.descriptionCode] - DESCRIPTION_CODE_ORDER[b.descriptionCode],
  );
  return partials[0];
}

function packageFixLine(release: AnalyzeProjectRelease): string | null {
  const fixes = packageCompleteFixes(release);
  if (fixes.length === 0) {
    return null;
  }
  const parts = fixes.map((o) => `${o.version} (complete fix)`);
  return `Fix: Change version to ${parts.join(' | ')}`;
}

function packageCompleteFixes(release: AnalyzeProjectRelease): VersionOption[] {
  const issues = release.issues;
  if (issues.length === 0) return [];

  const perIssueCompleteFixes = issues.map(completeFixesByVersion);
  if (perIssueCompleteFixes.some((m) => m.size === 0)) return [];

  const sharedVersions = intersectKeys(perIssueCompleteFixes);
  if (sharedVersions.size === 0) return [];

  const representatives: VersionOption[] = [];
  for (const version of sharedVersions) {
    representatives.push(bestRepresentative(version, perIssueCompleteFixes));
  }
  representatives.sort(
    (a, b) => DESCRIPTION_CODE_ORDER[a.descriptionCode] - DESCRIPTION_CODE_ORDER[b.descriptionCode],
  );
  return representatives.slice(0, MAX_PACKAGE_FIXES);
}

function completeFixesByVersion(issue: AnalyzeProjectIssue): Map<string, VersionOption> {
  const out = new Map<string, VersionOption>();
  const options = issue.versionOptions;
  if (!options) return out;
  for (const option of options) {
    if (option.fixLevel !== 'COMPLETE') continue;
    if (EXCLUDED_DESCRIPTION_CODES.has(option.descriptionCode)) continue;
    out.set(option.version, option);
  }
  return out;
}

function intersectKeys(maps: Map<string, VersionOption>[]): Set<string> {
  if (maps.length === 0) return new Set();
  let intersection = new Set(maps[0].keys());
  for (let i = 1; i < maps.length; i++) {
    const next = new Set<string>();
    for (const key of intersection) {
      if (maps[i].has(key)) next.add(key);
    }
    intersection = next;
    if (intersection.size === 0) break;
  }
  return intersection;
}

function bestRepresentative(
  version: string,
  perIssueCompleteFixes: Map<string, VersionOption>[],
): VersionOption {
  // Every map in `perIssueCompleteFixes` contains `version` by construction
  // (it came from the intersection of their keys), so collect-then-sort is
  // safe and lets the compiler narrow the result.
  const candidates: VersionOption[] = [];
  for (const map of perIssueCompleteFixes) {
    const option = map.get(version);
    if (option) candidates.push(option);
  }
  if (candidates.length === 0) {
    throw new Error(`bestRepresentative invariant violated: ${version} missing from inputs`);
  }
  candidates.sort(
    (a, b) => DESCRIPTION_CODE_ORDER[a.descriptionCode] - DESCRIPTION_CODE_ORDER[b.descriptionCode],
  );
  return candidates[0];
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

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

import { stripVTControlCharacters } from 'node:util';

import {
  type ContainerScanFinding,
  type ContainerScanReport,
  countContainerAnalysisErrors,
  EXIT_CODE_CONTAINER_THRESHOLD_REACHED,
  meetsContainerThreshold,
} from './container-scanner-report.ts';
import type { ContainerScanSeverity } from './container-scanner-runner.ts';
import { pluralize } from './dependency-risk-helpers/pluralize.ts';
import { compactCvssScore, CVSS_SCORE_WIDTH, formatCvssPrefix } from './format-cvss.ts';
import { compareSeverity } from './severity.ts';

const SKIPPED_PACKAGES_WARNING_PATTERN =
  /^WARNING: the backend skipped [1-9]\d* package\(s\)(?::|\r?$)/m;
const SEVERITY_WIDTH = 'BLOCKER'.length;

export function sanitizeScannerTerminalText(text: string): string {
  // Preserve each diagnostic line even after a truncated control sequence.
  return text
    .split(/\r?\n/)
    .map((line) => stripVTControlCharacters(line).replaceAll(/[\p{Cc}\p{Bidi_Control}]/gu, ''))
    .join('\n');
}

function scanTableCell(text: string): string {
  return sanitizeScannerTerminalText(text).replaceAll('\n', ' ');
}

function cleanCell(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const cleaned = scanTableCell(text).trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

export function hasSkippedPackagesWarning(stderr: string): boolean {
  return SKIPPED_PACKAGES_WARNING_PATTERN.test(sanitizeScannerTerminalText(stderr));
}

interface FindingRow {
  severity: string;
  cvssScore: string | null;
  identifier: string;
}

interface PackageGroup {
  key: string | undefined;
  label: string;
  findings: FindingRow[];
}

function packageKey({
  packageUrl,
  packageName,
  version,
}: ContainerScanFinding): string | undefined {
  // Ignore fields without displayable text, but keep the source value as the grouping key.
  if (packageUrl && cleanCell(packageUrl)) return `purl:${packageUrl}`;
  if (!packageName || !cleanCell(packageName)) return undefined;
  return `pkg:${JSON.stringify([packageName, cleanCell(version) ? version : null])}`;
}

function packageLabel(findings: ContainerScanFinding[]): string {
  for (const finding of findings) {
    const name = cleanCell(finding.packageName);
    const version = cleanCell(finding.version);
    if (name && version) return `${name}@${version}`;
  }
  const first = findings[0];
  return cleanCell(first.packageUrl) ?? cleanCell(first.packageName) ?? 'Unknown package';
}

function toFindingRow(finding: ContainerScanFinding): FindingRow {
  return {
    severity: finding.severity.toUpperCase(),
    cvssScore: cleanCell(finding.cvssScore) ?? null,
    identifier: cleanCell(finding.vulnerabilityId) ?? cleanCell(finding.key) ?? 'Unknown finding',
  };
}

function groupFindingsByPackage(findings: ContainerScanFinding[]): PackageGroup[] {
  const byPackage = new Map<string | undefined, ContainerScanFinding[]>();
  for (const finding of findings) {
    const key = packageKey(finding);
    const group = byPackage.get(key);
    if (group) group.push(finding);
    else byPackage.set(key, [finding]);
  }

  const groups = Array.from(byPackage, ([key, group]) => ({
    key,
    label: packageLabel(group),
    findings: group
      .map(toFindingRow)
      .sort(
        (a, b) =>
          compareSeverity(a.severity, b.severity) || a.identifier.localeCompare(b.identifier),
      ),
  }));
  return groups.sort(
    (a, b) =>
      compareSeverity(a.findings[0].severity, b.findings[0].severity) ||
      a.label.localeCompare(b.label) ||
      (a.key ?? 'unknown').localeCompare(b.key ?? 'unknown'),
  );
}

function cvssColumnWidth(groups: PackageGroup[]): number {
  let width = 0;
  for (const group of groups) {
    for (const { cvssScore } of group.findings) {
      if (cvssScore !== null) {
        width = Math.max(width, CVSS_SCORE_WIDTH, compactCvssScore(cvssScore).length);
      }
    }
  }
  return width;
}

function formatFindingRow(finding: FindingRow, cvssScoreWidth: number): string {
  const severity = finding.severity.padEnd(SEVERITY_WIDTH);
  const cvss = cvssScoreWidth > 0 ? `${formatCvssPrefix(finding.cvssScore, cvssScoreWidth)}  ` : '';
  return `  ${severity}  ${cvss}${finding.identifier}`;
}

function formatSummary(groups: PackageGroup[], totalFindings: number): string {
  const unknownFindings = groups.find(({ key }) => key === undefined)?.findings.length ?? 0;
  const packageCount = groups.length - Number(unknownFindings > 0);
  const identifiedFindings = totalFindings - unknownFindings;
  const summary: string[] = [];
  if (packageCount > 0) {
    summary.push(
      `${identifiedFindings} ${pluralize(identifiedFindings, 'finding')} in ${packageCount} affected ${pluralize(packageCount, 'package')}`,
    );
  }
  if (unknownFindings > 0) {
    summary.push(
      `${unknownFindings} ${pluralize(unknownFindings, 'finding')} with unknown package identity`,
    );
  }
  return `Summary: ${summary.join(' · ')}`;
}

function formatThresholdLine(failOn: ContainerScanSeverity, reachedThreshold: number): string {
  if (failOn === 'none') return 'Fail threshold: disabled';
  return `Fail threshold: ${failOn.toUpperCase()} · ${reachedThreshold} ${pluralize(reachedThreshold, 'finding')} reached the threshold`;
}

export function formatContainerScanTable(report: ContainerScanReport, stderr = ''): string {
  const lines = [`Image: ${scanTableCell(report.configuration.imageInput)}`, ''];
  if (report.exitCode !== 0 && report.exitCode !== EXIT_CODE_CONTAINER_THRESHOLD_REACHED) {
    const status = report.exitCode === 1 ? 'Container scan failed.' : 'Container scan cancelled.';
    return [...lines, status].join('\n');
  }

  const partial = countContainerAnalysisErrors(report) > 0 || hasSkippedPackagesWarning(stderr);
  if (report.issues.length === 0) {
    const empty = partial ? 'No findings in the packages analyzed.' : 'No findings.';
    return [...lines, empty].join('\n');
  }
  if (partial) lines.push('Results are incomplete.', '');

  const groups = groupFindingsByPackage(report.issues);
  const width = cvssColumnWidth(groups);
  for (const { label, findings } of groups) {
    lines.push(`── ${label} (${findings.length} ${pluralize(findings.length, 'finding')}) ──`);
    for (const finding of findings) lines.push(formatFindingRow(finding, width));
    lines.push('');
  }

  const { failOn } = report.configuration;
  const reachedThreshold = report.issues.filter(({ severity }) =>
    meetsContainerThreshold(severity, failOn),
  ).length;
  lines.push(
    formatSummary(groups, report.issues.length),
    `Highest severity: ${groups[0].findings[0].severity}`,
    formatThresholdLine(failOn, reachedThreshold),
  );
  return lines.join('\n');
}

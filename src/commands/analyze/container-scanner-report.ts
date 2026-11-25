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

import type { SpawnResult } from '@/core/process/process.ts';

import {
  CONTAINER_SCAN_SEVERITIES,
  type ContainerScanCancellationExitCode,
  type ContainerScanOptions,
  type ContainerScanSeverity,
} from './container-scanner-runner.ts';
import { pluralize } from './dependency-risk-helpers/pluralize.ts';

export type ContainerFindingSeverity = Exclude<ContainerScanSeverity, 'none'>;

export interface ContainerScanFinding {
  severity: ContainerFindingSeverity;
  packageName?: string | null;
  packageUrl?: string | null;
  version?: string | null;
  vulnerabilityId?: string | null;
  key?: string | null;
  cvssScore?: string | null;
}

export interface ContainerScanError {
  kind: string;
  message: string;
}

export interface ContainerScanConfiguration {
  imageInput: string;
  failOn: ContainerScanSeverity;
  timeoutSecs: number;
  registry?: string | null;
  repository?: string | null;
  tag?: string | null;
}

export const EXIT_CODE_CONTAINER_THRESHOLD_REACHED = 51;
export type ContainerScanExitCode =
  0 | 1 | typeof EXIT_CODE_CONTAINER_THRESHOLD_REACHED | ContainerScanCancellationExitCode;

export interface ContainerScanReport {
  issues: ContainerScanFinding[];
  errors: ContainerScanError[];
  configuration: ContainerScanConfiguration;
  exitCode: ContainerScanExitCode;
}

const EXIT_CODE_BY_SCANNER_STATUS = new Map<number, ContainerScanExitCode>([
  [0, 0],
  [1, EXIT_CODE_CONTAINER_THRESHOLD_REACHED],
  [2, 1],
]);

const FINDING_SEVERITY_RANK: Record<ContainerFindingSeverity, number> = {
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
  blocker: 5,
};

const SCAN_SEVERITIES: ReadonlySet<string> = new Set(CONTAINER_SCAN_SEVERITIES);
const SKIPPED_PACKAGES_WARNING_PATTERN =
  /^WARNING: the backend skipped [1-9]\d* package\(s\)(?::|\r?$)/m;
const SEVERITY_WIDTH = 'BLOCKER'.length;
const MIN_CVSS_SCORE_WIDTH = 'X.Y'.length;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isSeverity(value: unknown): value is ContainerScanSeverity {
  return typeof value === 'string' && SCAN_SEVERITIES.has(value);
}

function isFindingSeverity(value: unknown): value is ContainerFindingSeverity {
  return typeof value === 'string' && Object.hasOwn(FINDING_SEVERITY_RANK, value);
}

function isFinding(value: unknown): value is ContainerScanFinding {
  return (
    isObject(value) &&
    isFindingSeverity(value.severity) &&
    ['packageName', 'packageUrl', 'version', 'vulnerabilityId', 'key', 'cvssScore'].every((field) =>
      isOptionalText(value[field]),
    )
  );
}

function isScanError(value: unknown): value is ContainerScanError {
  return isObject(value) && typeof value.kind === 'string' && typeof value.message === 'string';
}

function isConfiguration(value: unknown): value is ContainerScanConfiguration {
  return (
    isObject(value) &&
    typeof value.imageInput === 'string' &&
    isSeverity(value.failOn) &&
    typeof value.timeoutSecs === 'number' &&
    Number.isSafeInteger(value.timeoutSecs) &&
    value.timeoutSecs > 0 &&
    ['registry', 'repository', 'tag'].every((field) => isOptionalText(value[field]))
  );
}

function mapScannerExitCode(exitCode: number | null): ContainerScanExitCode | undefined {
  if (exitCode === null) return undefined;
  return EXIT_CODE_BY_SCANNER_STATUS.get(exitCode);
}

function getThresholdRank(failOn: ContainerScanSeverity): number | undefined {
  return failOn === 'none' ? undefined : FINDING_SEVERITY_RANK[failOn];
}

export function parseContainerScanReport(result: SpawnResult): ContainerScanReport | undefined {
  const { exitCode } = result;
  const publicExitCode = mapScannerExitCode(exitCode);
  if (publicExitCode === undefined) return;

  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    return;
  }

  if (
    !isObject(report) ||
    report.exitCode !== exitCode ||
    !Array.isArray(report.issues) ||
    !report.issues.every(isFinding) ||
    !Array.isArray(report.errors) ||
    !report.errors.every(isScanError) ||
    !isConfiguration(report.configuration)
  ) {
    return;
  }

  const thresholdRank = getThresholdRank(report.configuration.failOn);
  const reachesThreshold =
    thresholdRank !== undefined &&
    report.issues.some((issue) => FINDING_SEVERITY_RANK[issue.severity] >= thresholdRank);
  if ((exitCode === 1 && !reachesThreshold) || (exitCode === 0 && reachesThreshold)) {
    return;
  }

  return {
    ...report,
    issues: report.issues,
    errors: report.errors,
    configuration: report.configuration,
    exitCode: publicExitCode,
  };
}

export function containerScanErrorReport(
  image: string,
  options: ContainerScanOptions,
  error: ContainerScanError,
  exitCode: 1 | ContainerScanCancellationExitCode = 1,
): ContainerScanReport {
  const { failOn, timeoutSecs, registry, repository, tag } = options;
  return {
    issues: [],
    errors: [error],
    configuration: {
      imageInput: image,
      failOn,
      timeoutSecs,
      registry: registry ?? null,
      repository: repository ?? null,
      tag: tag ?? null,
    },
    exitCode,
  };
}

export function countContainerAnalysisErrors(report: ContainerScanReport): number {
  return report.errors.filter(({ kind }) => kind === 'backendAnalysis').length;
}

export function hasSkippedPackagesWarning(stderr: string): boolean {
  return SKIPPED_PACKAGES_WARNING_PATTERN.test(sanitizeScannerTerminalText(stderr));
}

function isPartialScan(report: ContainerScanReport, stderr: string): boolean {
  return countContainerAnalysisErrors(report) > 0 || hasSkippedPackagesWarning(stderr);
}

export function formatContainerScanJson(report: ContainerScanReport): string {
  // JSON.stringify escapes C0 controls. Escape additional terminal and bidi controls as valid JSON.
  return JSON.stringify(report, null, 2).replaceAll(
    /[\u007F-\u009F\p{Bidi_Control}]/gu,
    (character) => String.raw`\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
  );
}

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

interface NormalizedFinding {
  severity: ContainerFindingSeverity;
  rank: number;
  cvssScore?: string;
  identifier: string;
  groupKey: string;
  label: string;
  hasNameAndVersion: boolean;
}

interface PackageGroup {
  key: string;
  label: string;
  hasNameAndVersion: boolean;
  highestRank: number;
  findings: NormalizedFinding[];
}

function findingGroupKey(
  packageUrl: string | undefined,
  packageName: string | undefined,
  version: string | undefined,
): string {
  if (packageUrl) return `purl:${packageUrl}`;
  if (packageName) return `pkg:${JSON.stringify([packageName, version ?? null])}`;
  return 'unknown';
}

function normalizeFinding(finding: ContainerScanFinding): NormalizedFinding {
  const packageUrl = cleanCell(finding.packageUrl);
  const packageName = cleanCell(finding.packageName);
  const version = cleanCell(finding.version);
  const hasNameAndVersion = Boolean(packageName && version);
  const label = hasNameAndVersion
    ? `${packageName}@${version}`
    : (packageUrl ?? packageName ?? 'Unknown package');
  const groupKey = findingGroupKey(packageUrl, packageName, version);
  const rawCvss = cleanCell(finding.cvssScore);
  const cvssScore = rawCvss === '10.0' ? '10' : rawCvss;
  const identifier =
    cleanCell(finding.vulnerabilityId) ?? cleanCell(finding.key) ?? 'Unknown finding';

  return {
    severity: finding.severity,
    rank: FINDING_SEVERITY_RANK[finding.severity],
    cvssScore,
    identifier,
    groupKey,
    label,
    hasNameAndVersion,
  };
}

function formatFindingRow(finding: NormalizedFinding, cvssScoreWidth: number): string {
  const severity = finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH);
  let cvss = '';
  if (cvssScoreWidth > 0) {
    cvss = finding.cvssScore
      ? `CVSS ${finding.cvssScore.padStart(cvssScoreWidth)}  `
      : `${' '.repeat('CVSS '.length + cvssScoreWidth)}  `;
  }
  return `  ${severity}  ${cvss}${finding.identifier}`;
}

function groupFindingsByPackage(findings: NormalizedFinding[]): PackageGroup[] {
  const groupsByKey = new Map<string, PackageGroup>();
  for (const finding of findings) {
    const existing = groupsByKey.get(finding.groupKey);
    if (existing) {
      existing.findings.push(finding);
      if (finding.rank > existing.highestRank) existing.highestRank = finding.rank;
      if (!existing.hasNameAndVersion && finding.hasNameAndVersion) {
        existing.label = finding.label;
        existing.hasNameAndVersion = true;
      }
    } else {
      groupsByKey.set(finding.groupKey, {
        key: finding.groupKey,
        label: finding.label,
        hasNameAndVersion: finding.hasNameAndVersion,
        highestRank: finding.rank,
        findings: [finding],
      });
    }
  }

  const groups = [...groupsByKey.values()];
  for (const group of groups) {
    group.findings.sort((a, b) => b.rank - a.rank || a.identifier.localeCompare(b.identifier));
  }
  groups.sort(
    (a, b) =>
      b.highestRank - a.highestRank || a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
  );
  return groups;
}

function summarizeFindings(
  findings: NormalizedFinding[],
  failOn: ContainerScanSeverity,
): { highest: ContainerFindingSeverity; reachedThreshold: number } {
  const thresholdRank = getThresholdRank(failOn);
  let highest = findings[0].severity;
  let reachedThreshold = 0;
  for (const finding of findings) {
    if (finding.rank > FINDING_SEVERITY_RANK[highest]) highest = finding.severity;
    if (thresholdRank !== undefined && finding.rank >= thresholdRank) reachedThreshold++;
  }
  return { highest, reachedThreshold };
}

function formatPackageGroup(group: PackageGroup, cvssScoreWidth: number): string[] {
  return [
    `── ${group.label} (${group.findings.length} ${pluralize(group.findings.length, 'finding')}) ──`,
    ...group.findings.map((finding) => formatFindingRow(finding, cvssScoreWidth)),
    '',
  ];
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
  if (report.issues.length === 0) {
    const empty = isPartialScan(report, stderr)
      ? 'No findings in the packages analyzed.'
      : 'No findings.';
    return [...lines, empty].join('\n');
  }

  const normalized = report.issues.map(normalizeFinding);
  const groups = groupFindingsByPackage(normalized);
  const cvssScoreWidth = normalized.reduce(
    (width, { cvssScore }) =>
      cvssScore ? Math.max(width, MIN_CVSS_SCORE_WIDTH, cvssScore.length) : width,
    0,
  );
  const { highest, reachedThreshold } = summarizeFindings(normalized, report.configuration.failOn);

  for (const group of groups) {
    lines.push(...formatPackageGroup(group, cvssScoreWidth));
  }

  lines.push(
    `Summary: ${report.issues.length} ${pluralize(report.issues.length, 'finding')} in ${groups.length} affected ${pluralize(groups.length, 'package')}`,
    `Highest severity: ${highest.toUpperCase()}`,
    formatThresholdLine(report.configuration.failOn, reachedThreshold),
  );
  return lines.join('\n');
}

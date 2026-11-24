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
  type ContainerScanOptions,
  type ContainerScanSeverity,
} from './container-scanner-runner.ts';
import { pluralize } from './dependency-risk-helpers/pluralize.ts';

interface ContainerScanFinding {
  severity: ContainerScanSeverity;
  packageName?: string | null;
  packageUrl?: string | null;
  version?: string | null;
  vulnerabilityId?: string | null;
  key?: string | null;
  cvssScore?: string | null;
}

interface ContainerScanError {
  kind: string;
  message: string;
}

interface ContainerScanConfiguration {
  imageInput: string;
  failOn: ContainerScanSeverity;
  timeoutSecs: number;
  registry?: string | null;
  repository?: string | null;
  tag?: string | null;
}

const EXIT_CODE_THRESHOLD_REACHED = 51;
const EXIT_CODE_BY_SCANNER_STATUS = { 0: 0, 1: EXIT_CODE_THRESHOLD_REACHED, 2: 1 } as const;
type ContainerScanExitCode =
  (typeof EXIT_CODE_BY_SCANNER_STATUS)[keyof typeof EXIT_CODE_BY_SCANNER_STATUS];

export interface ContainerScanReport {
  issues: ContainerScanFinding[];
  errors: ContainerScanError[];
  configuration: ContainerScanConfiguration;
  exitCode: ContainerScanExitCode;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isSeverity(value: unknown): value is ContainerScanSeverity {
  return (
    typeof value === 'string' && (CONTAINER_SCAN_SEVERITIES as readonly string[]).includes(value)
  );
}

function isFinding(value: unknown): value is ContainerScanFinding {
  return (
    isObject(value) &&
    isSeverity(value.severity) &&
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

export function parseContainerScanReport(result: SpawnResult): ContainerScanReport | undefined {
  const { exitCode } = result;
  if (exitCode !== 0 && exitCode !== 1 && exitCode !== 2) return;

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

  return {
    ...report,
    issues: report.issues,
    errors: report.errors,
    configuration: report.configuration,
    exitCode: EXIT_CODE_BY_SCANNER_STATUS[exitCode],
  };
}

export function containerScanErrorReport(
  image: string,
  options: ContainerScanOptions,
  error: ContainerScanError,
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
    exitCode: 1,
  };
}

export function countContainerAnalysisErrors(report: ContainerScanReport): number {
  return report.errors.filter(({ kind }) => kind === 'backendAnalysis').length;
}

function isPartialScan(report: ContainerScanReport, stderr: string): boolean {
  return (
    countContainerAnalysisErrors(report) > 0 ||
    /^WARNING: the backend skipped [1-9]\d* package\(s\)(?::|\r?$)/m.test(stderr)
  );
}

export function formatContainerScanJson(report: ContainerScanReport): string {
  // JSON.stringify escapes C0 controls. Escape additional terminal and bidi controls as valid JSON.
  return JSON.stringify(report, null, 2).replaceAll(
    /[\u007F-\u009F\p{Bidi_Control}]/gu,
    (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return String.raw`\u${codePoint.toString(16).padStart(4, '0')}`;
    },
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

function severityRank(severity: ContainerScanSeverity): number {
  return CONTAINER_SCAN_SEVERITIES.indexOf(severity);
}

function packageLabel({ packageName, packageUrl, version }: ContainerScanFinding): string {
  if (packageName && version) return `${scanTableCell(packageName)}@${scanTableCell(version)}`;
  return scanTableCell(packageUrl || packageName || 'Unknown package');
}

function formatFinding(finding: ContainerScanFinding): string {
  const severity = finding.severity.toUpperCase().padEnd(8);
  const cvss = finding.cvssScore ? `CVSS ${scanTableCell(finding.cvssScore)}  ` : '';
  const identifier = scanTableCell(finding.vulnerabilityId || finding.key || 'Unknown finding');
  return `  ${severity}  ${cvss}${identifier}`;
}

function groupFindingsByPackage(
  findings: ContainerScanFinding[],
): Map<string, ContainerScanFinding[]> {
  const affectedPackages = new Map<string, ContainerScanFinding[]>();
  for (const finding of findings) {
    const key = finding.packageUrl || JSON.stringify([finding.packageName, finding.version]);
    const group = affectedPackages.get(key);
    if (group) group.push(finding);
    else affectedPackages.set(key, [finding]);
  }
  return affectedPackages;
}

export function formatContainerScanTable(report: ContainerScanReport, stderr: string): string {
  const lines = [`Image: ${scanTableCell(report.configuration.imageInput)}`, ''];
  if (report.exitCode === 1) return [...lines, 'Container scan failed.'].join('\n');
  if (report.issues.length === 0) {
    const empty = isPartialScan(report, stderr)
      ? 'No findings in the packages analyzed.'
      : 'No findings.';
    return [...lines, empty].join('\n');
  }

  const affectedPackages = groupFindingsByPackage(report.issues);
  let highest = 0;
  let reachedThreshold = 0;
  const threshold = severityRank(report.configuration.failOn);
  for (const findings of affectedPackages.values()) {
    const title = packageLabel(findings[0]);
    lines.push(`── ${title} (${findings.length} ${pluralize(findings.length, 'finding')}) ──`);
    findings.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    for (const finding of findings) {
      const rank = severityRank(finding.severity);
      highest = Math.max(highest, rank);
      if (threshold > 0 && rank >= threshold) reachedThreshold++;
      lines.push(formatFinding(finding));
    }
    lines.push('');
  }
  const packages = affectedPackages.size;
  lines.push(
    `Summary: ${report.issues.length} ${pluralize(report.issues.length, 'finding')} in ${packages} affected ${pluralize(packages, 'package')}`,
    `Highest severity: ${CONTAINER_SCAN_SEVERITIES[highest].toUpperCase()}`,
    threshold === 0
      ? 'Fail threshold: disabled'
      : `Fail threshold: ${report.configuration.failOn.toUpperCase()} · ${reachedThreshold} ${pluralize(reachedThreshold, 'finding')} reached the threshold`,
  );
  return lines.join('\n');
}

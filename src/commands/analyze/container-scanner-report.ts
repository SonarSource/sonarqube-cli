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

import type { SpawnResult } from '@/core/process/process.ts';

import {
  CONTAINER_SCAN_SEVERITIES,
  type ContainerScanCancellationExitCode,
  type ContainerScanOptions,
  type ContainerScanSeverity,
} from './container-scanner-runner.ts';
import { compareSeverity } from './severity.ts';

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

const SCAN_SEVERITIES: ReadonlySet<string> = new Set(CONTAINER_SCAN_SEVERITIES);

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
  return isSeverity(value) && value !== 'none';
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

export function meetsContainerThreshold(
  severity: ContainerFindingSeverity,
  failOn: ContainerScanSeverity,
): boolean {
  return failOn !== 'none' && compareSeverity(severity.toUpperCase(), failOn.toUpperCase()) <= 0;
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

  if (exitCode === 0 || exitCode === 1) {
    const failOn = report.configuration.failOn;
    const meetsThreshold = report.issues.some(({ severity }) =>
      meetsContainerThreshold(severity, failOn),
    );
    if (meetsThreshold !== (exitCode === 1)) return;
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

export function formatContainerScanJson(report: ContainerScanReport): string {
  // JSON.stringify escapes C0 controls. Escape additional terminal and bidi controls as valid JSON.
  return JSON.stringify(report, null, 2).replaceAll(
    /[\u007F-\u009F\p{Bidi_Control}]/gu,
    (character) => String.raw`\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
  );
}

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

import type { SpawnResult } from '../../../../lib/process.ts';
import { type ScaScannerInvocation, ScaScannerRunnerBase } from './sca-scanner-runner-base.ts';

// Response shape from sca-scanner. Mirrors `AnalyzeProjectResponse` in
// sonar-sca (SCA-1835) — the same external-facing schema used by persisted
// analyses.
export interface AnalyzeProjectResponse {
  releases: AnalyzeProjectRelease[];
  parsedFiles: string[];
  errors: AnalysisErrorResource[];
}

export interface AnalyzeProjectRelease {
  key: string;
  packageUrl: string;
  packageManager: string;
  packageName: string;
  version: string;
  licenseExpression: string | null;
  known: boolean;
  knownPackage: boolean;
  newlyIntroduced: boolean;
  issues: AnalyzeProjectIssue[];
  dependencyFilePaths: string[];
  dependencyChains: string[][];
}

export type ScaIssueType = 'VULNERABILITY' | 'PROHIBITED_LICENSE' | 'MALWARE';
export type SoftwareQuality = 'MAINTAINABILITY' | 'RELIABILITY' | 'SECURITY';
export type Severity = 'BLOCKER' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type ScaStatus = 'OPEN' | 'CONFIRM' | 'SAFE' | 'FIXED' | 'ACCEPT';

export interface AnalyzeProjectIssue {
  key: string | null;
  severity: Severity;
  showIncreasedSeverityWarning: boolean | null;
  type: ScaIssueType;
  quality: SoftwareQuality;
  status: ScaStatus | null;
  vulnerabilityId: string | null;
  cweIds: string[] | null;
  cvssScore: string | null;
  spdxLicenseId: string | null;
  versionOptions: VersionOption[] | null;
}

export type VersionOptionDescriptionCode =
  | 'VERSION_IN_USE'
  | 'NEAREST_PARTIAL'
  | 'NEAREST_COMPLETE'
  | 'LATEST_PARTIAL'
  | 'LATEST_COMPLETE'
  | 'LATEST_STABLE'
  | 'LATEST_PRERELEASE'
  | 'UNKNOWN';

export type VersionOptionFixLevel = 'COMPLETE' | 'PARTIAL' | 'NONE' | 'UNKNOWN';

export interface VersionOption {
  version: string;
  vulnerabilityIds: string[];
  prerelease: boolean;
  fixLevel: VersionOptionFixLevel;
  descriptionCode: VersionOptionDescriptionCode;
}

export type ScaAnalysisErrorCode =
  | 'UNKNOWN'
  | 'NO_DEPENDENCIES_FOUND'
  | 'DEPENDENCY_FILES_PARSE_ERROR'
  | 'UNSUPPORTED_PLATFORM'
  | 'INEXACT_VERSIONS'
  | 'MISSING_LOCKFILE';

export interface AnalysisErrorResource {
  id: string;
  code: ScaAnalysisErrorCode;
  path: string | null;
  message: string;
}

export class ScaScannerRunner extends ScaScannerRunnerBase<AnalyzeProjectResponse> {
  buildArgs(invocation: ScaScannerInvocation): string[] {
    return this.buildBaseArgs('analyze-project', invocation, [
      `--project-key=${invocation.projectKey}`,
    ]);
  }

  protected readonly errorPrefix = 'Dependency risk analysis error';

  protected parseResult(result: SpawnResult): AnalyzeProjectResponse {
    return this.parseJson(result) as AnalyzeProjectResponse;
  }
}

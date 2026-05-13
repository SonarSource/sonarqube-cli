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

import { rmSync } from 'node:fs';

import { LOG_FILE } from '../../../../lib/config-constants.ts';
import logger from '../../../../lib/logger.ts';
import type { SpawnResult } from '../../../../lib/process.ts';
import { warn } from '../../../../ui';
import { CommandFailedError } from '../../_common/error.ts';
import { type ScaScannerInstaller } from '../../_common/install/sca-scanner.ts';
import { type ScaScannerSpawner } from './sca-scanner-spawner.ts';

const REDACTED_TOKEN = '***';

export interface ScaScannerInvocation {
  baseDir: string;
  apiBaseUrl: string;
  downloadBaseUrl: string;
  sonarToken: string;
  projectKey: string;
  cacheDir: string;
  workDir: string;
  scannerProperties: Record<string, string>;
  excludedPaths: string[];
  includeGitIgnoredPaths: boolean;
  debug: boolean;
}

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

export interface AnalyzeProjectIssue {
  key: string | null;
  severity: string;
  showIncreasedSeverityWarning: boolean | null;
  type: ScaIssueType;
  quality: SoftwareQuality;
  status: string | null;
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

export class ScaScannerRunner {
  constructor(
    private readonly installer: ScaScannerInstaller,
    private readonly spawner: ScaScannerSpawner,
  ) {}

  async run(invocation: ScaScannerInvocation): Promise<AnalyzeProjectResponse> {
    const args = this.buildArgs(invocation);
    logger.debug(`sca-scanner args: ${JSON.stringify(this.redactedArgs(args))}`);

    const binaryPath = await this.installer.install();

    let result: SpawnResult;
    try {
      result = await this.spawner.spawn(binaryPath, args);
    } catch (err) {
      throw new CommandFailedError(`Dependency risk analysis error: ${(err as Error).message}`);
    } finally {
      this.cleanupWorkDir(invocation.workDir);
    }

    logger.info(`SCA Scanner stdout\n${result.stdout}`);
    logger.warn(`SCA Scanner stderr\n${result.stderr}`);
    return this.reportScanResult(result);
  }

  buildArgs(invocation: ScaScannerInvocation): string[] {
    const args: string[] = [
      'analyze-project',
      `--base-dir=${invocation.baseDir}`,
      `--api-base-url=${invocation.apiBaseUrl}`,
      `--download-base-url=${invocation.downloadBaseUrl}`,
      `--sonar-token=${invocation.sonarToken}`,
      `--project-key=${invocation.projectKey}`,
      `--cache-dir=${invocation.cacheDir}`,
      `--work-dir=${invocation.workDir}`,
    ];
    for (const [name, value] of Object.entries(invocation.scannerProperties)) {
      args.push(`--scanner-property=${name}=${value}`);
    }
    for (const path of invocation.excludedPaths) {
      args.push(`--excluded-path=${path}`);
    }
    if (invocation.includeGitIgnoredPaths) {
      args.push('--include-gitignored-paths');
    }
    if (invocation.debug) {
      args.push('--debug');
    }
    return args;
  }

  private redactedArgs(args: string[]): string[] {
    return args.map((arg) =>
      arg.startsWith('--sonar-token=') ? `--sonar-token=${REDACTED_TOKEN}` : arg,
    );
  }

  private reportScanResult(result: SpawnResult): AnalyzeProjectResponse {
    const exitCode = result.exitCode ?? 1;
    if (exitCode === 0) {
      return this.handleScanSuccess(result);
    }
    return this.handleScanFailure(exitCode);
  }

  private handleScanSuccess(result: SpawnResult): AnalyzeProjectResponse {
    try {
      return JSON.parse(result.stdout) as AnalyzeProjectResponse;
    } catch (err) {
      throw new CommandFailedError(
        `Dependency risk analysis error: failed to parse output (${(err as Error).message})`,
      );
    }
  }

  private handleScanFailure(exitCode: number): never {
    throw new CommandFailedError(
      `Dependency risk analysis error: sca-scanner exited with code ${exitCode}. See logs for details: ${LOG_FILE}`,
    );
  }

  private cleanupWorkDir(workDir: string): void {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warn(`Failed to clean up SCA scanner working directory ${workDir}: ${reason}`);
    }
  }
}

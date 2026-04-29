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

// Scaffold for the sca-scanner invocation. The binary is not yet shipped,
// so production wiring uses `NoopScaScannerRunner`, which returns an empty
// result without attempting an install. The full spawn → parse → error path
// in `ScaScannerRunner` (modeled after `analyze secrets`) stays covered by
// unit tests so it's ready to swap in when the binary lands.

import logger from '../../../../lib/logger.ts';
import type { SpawnResult } from '../../../../lib/process.ts';
import { CommandFailedError } from '../../_common/error.ts';
import { type ScaScannerInstallerLike } from '../../_common/install/sca-scanner.ts';
import { type ScaScannerSpawnerLike } from './sca-scanner-spawner.ts';

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
// sonar-sca (SCA-1852) so the same parser can consume both wrapper output and
// persisted-analysis responses (SCA-1761 wrapper-compatibility constraint).
export interface ScaPackageInfoResponse {
  packages: ScaPackage[];
  parsedFiles: string[];
  errors: ScaAnalysisError[];
}

export interface ScaPackage {
  purl: string;
  dependencyFilePaths: string[];
  dependencyChains: string[][];
  license: ScaLicense | null;
  vulnerabilities: ScaVulnerability[] | null;
  malicious: boolean;
  knownPackage: boolean;
  knownRelease: boolean;
}

export interface ScaLicense {
  expression: string;
  allowed: boolean | null;
}

export interface ScaVulnerability {
  id: string;
  cvssScore: number;
  cweIds: string[];
  riskSeverity: string;
  withdrawn: boolean;
  publishedOn: string;
  fixedVersions: ScaVersionFix[] | null;
  unaffectedVersions: string[] | null;
}

export interface ScaVersionFix {
  version: string;
  fixLevel: string;
  descriptionCode: string;
}

export type ScaAnalysisErrorCode =
  | 'UNKNOWN'
  | 'NO_DEPENDENCIES_FOUND'
  | 'DEPENDENCY_FILES_PARSE_ERROR'
  | 'UNSUPPORTED_PLATFORM'
  | 'INEXACT_VERSIONS'
  | 'MISSING_LOCKFILE';

export interface ScaAnalysisError {
  id: string;
  code: ScaAnalysisErrorCode;
  path: string | null;
  message: string;
}

export class ScaScannerRunner {
  constructor(
    private readonly installer: ScaScannerInstallerLike,
    private readonly spawner: ScaScannerSpawnerLike,
  ) {}

  async run(invocation: ScaScannerInvocation): Promise<ScaPackageInfoResponse> {
    const args = this.buildArgs(invocation);
    logger.debug(`sca-scanner args: ${JSON.stringify(this.redactedArgs(args))}`);

    const binaryPath = await this.installer.install();

    let result: SpawnResult;
    try {
      result = await this.spawner.spawn(binaryPath, args);
    } catch (err) {
      throw new CommandFailedError(`Dependency collection error: ${(err as Error).message}`);
    }

    logger.info(result.stdout);
    logger.info(result.stderr);
    return reportScanResult(result);
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
}

function reportScanResult(result: SpawnResult): ScaPackageInfoResponse {
  const exitCode = result.exitCode ?? 1;
  if (exitCode === 0) {
    return handleScanSuccess(result);
  }
  return handleScanFailure(result, exitCode);
}

function handleScanSuccess(result: SpawnResult): ScaPackageInfoResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new CommandFailedError(
      `Dependency collection error: failed to parse output (${(err as Error).message})`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new CommandFailedError(
      `Dependency collection error: sca-scanner output is missing 'packages' array`,
    );
  }
  for (const field of ['packages', 'parsedFiles', 'errors'] as const) {
    if (!Array.isArray((parsed as Record<string, unknown>)[field])) {
      throw new CommandFailedError(
        `Dependency collection error: sca-scanner output is missing '${field}' array`,
      );
    }
  }
  return parsed as ScaPackageInfoResponse;
}

function handleScanFailure(result: SpawnResult, exitCode: number): never {
  throw new CommandFailedError(
    `Dependency collection error: sca-scanner exited with code ${exitCode}\n${result.stderr}`,
  );
}

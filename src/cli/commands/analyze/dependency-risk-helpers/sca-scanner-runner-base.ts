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
import { warn, withSpinner } from '../../../../ui';
import { CommandFailedError } from '../../_common/error.ts';
import { type ScaScannerInstaller } from '../../_common/install/sca-scanner.ts';
import { type ScaScannerSpawner } from './sca-scanner-spawner.ts';

/** Env var the sca-scanner reads the bearer token from. */
const SONAR_TOKEN_ENV = 'SONAR_TOKEN';

export const SCA_SCANNER_START_FAILURE_HINT =
  'Verify that the SCA scanner is installed and can run on this machine, then retry.';
export const SCA_SCANNER_PARSE_FAILURE_HINT = `Inspect ${LOG_FILE} for the raw sca-scanner output, then retry.`;
export const SCA_SCANNER_EXIT_FAILURE_HINT = `Inspect ${LOG_FILE} for the underlying sca-scanner error, fix the reported issue, then retry.`;

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

/**
 * Shared skeleton for runners that drive a `sca-scanner` subcommand: install
 * the binary, spawn the subcommand, validate the exit code, parse stdout, and
 * always clean up the work dir.
 */
export abstract class ScaScannerRunnerBase<T> {
  constructor(
    protected readonly installer: ScaScannerInstaller,
    protected readonly spawner: ScaScannerSpawner,
  ) {}

  async run(invocation: ScaScannerInvocation): Promise<T> {
    const args = this.buildArgs(invocation);
    logger.debug(`sca-scanner args: ${JSON.stringify(args)}`);
    const env = { [SONAR_TOKEN_ENV]: invocation.sonarToken };
    const binaryPath = await this.installer.install();
    try {
      const result = await withSpinner(
        this.spinnerLabel,
        () => this.spawnScanner(binaryPath, args, env),
        'stderr',
      );
      logger.info(`SCA Scanner stdout\n${result.stdout}`);
      logger.warn(`SCA Scanner stderr\n${result.stderr}`);
      this.assertSuccessfulExit(result);
      return this.parseResult(result);
    } finally {
      this.cleanupWorkDir(invocation.workDir);
    }
  }

  /** argv for the subcommand this runner drives. */
  abstract buildArgs(invocation: ScaScannerInvocation): string[];

  /** Builds the shared subcommand argv; `extraArgs` adds subcommand-specific options. */
  protected buildBaseArgs(
    subcommand: string,
    invocation: ScaScannerInvocation,
    extraArgs: string[] = [],
  ): string[] {
    const args: string[] = [
      subcommand,
      `--base-dir=${invocation.baseDir}`,
      `--api-base-url=${invocation.apiBaseUrl}`,
      `--download-base-url=${invocation.downloadBaseUrl}`,
      `--cache-dir=${invocation.cacheDir}`,
      `--work-dir=${invocation.workDir}`,
      ...extraArgs,
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

  /** Spinner label for this runner's subcommand execution. */
  protected abstract readonly spinnerLabel: string;

  /** Prefix prepended to every error message (e.g. `Manifest discovery error: failed to parse output (…)`). */
  protected abstract readonly errorPrefix: string;

  /** Interprets stdout of a successful (exit-code 0) run. */
  protected abstract parseResult(result: SpawnResult): T;

  protected parseJson(result: SpawnResult): unknown {
    try {
      return JSON.parse(result.stdout);
    } catch (err) {
      throw new CommandFailedError(
        `${this.errorPrefix}: failed to parse output (${(err as Error).message})`,
        { remediationHint: SCA_SCANNER_PARSE_FAILURE_HINT },
      );
    }
  }

  private async spawnScanner(
    binaryPath: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<SpawnResult> {
    try {
      return await this.spawner.spawn(binaryPath, args, env);
    } catch (err) {
      throw new CommandFailedError(`${this.errorPrefix}: ${(err as Error).message}`, {
        remediationHint: SCA_SCANNER_START_FAILURE_HINT,
      });
    }
  }

  private assertSuccessfulExit(result: SpawnResult): void {
    const exitCode = result.exitCode ?? 1;
    if (exitCode !== 0) {
      throw new CommandFailedError(
        `${this.errorPrefix}: sca-scanner exited with code ${exitCode}.`,
        { remediationHint: SCA_SCANNER_EXIT_FAILURE_HINT },
      );
    }
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

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

import type { ScaScannerInvocation } from './sca-scanner';

/**
 * Builds the argv for an sca-scanner subcommand. Every subcommand shares the
 * same connection, cache/work-dir, scanner-property, exclusion, and flag args;
 * `extraArgs` carries the subcommand-specific options (e.g. `--project-key`).
 */
function buildScaArgs(
  subcommand: string,
  invocation: ScaScannerInvocation,
  extraArgs: string[] = [],
): string[] {
  const args: string[] = [
    subcommand,
    `--base-dir=${invocation.baseDir}`,
    `--api-base-url=${invocation.apiBaseUrl}`,
    `--download-base-url=${invocation.downloadBaseUrl}`,
    `--sonar-token=${invocation.sonarToken}`,
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

/** Full argv for the `analyze-project` subcommand. */
export function buildAnalyzeProjectArgs(invocation: ScaScannerInvocation): string[] {
  return buildScaArgs('analyze-project', invocation, [`--project-key=${invocation.projectKey}`]);
}

/**
 * Full argv for the `discover-manifests` subcommand.
 */
export function buildDiscoverManifestsArgs(invocation: ScaScannerInvocation): string[] {
  return buildScaArgs('discover-manifests', invocation);
}

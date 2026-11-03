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

import { relative, sep } from 'node:path';

import { deriveEntry } from '@/commands/link/link-project.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { findGitRoot } from '@/core/host/git/discover.ts';
import { shellQuote } from '@/core/host/shell-quote.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import { sharedProjectConfigRepository } from '@/core/project-discovery/shared-project-config.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { QualityGatesClient } from '@/core/server/quality-gates.ts';
import type { Console } from '@/core/ui/console.ts';

export function linkCommand(projectKey: string, path: string, runFrom: string | undefined): string {
  const link =
    path === '.'
      ? `sonar link ${shellQuote(projectKey)}`
      : `sonar link ${shellQuote(projectKey)} --path ${shellQuote(path)}`;
  // Windows PowerShell 5.1, the default shell there, has no `&&`.
  const separator = process.platform === 'win32' ? '; ' : ' && ';
  return runFrom === undefined ? link : `cd ${shellQuote(runFrom)}${separator}${link}`;
}

/** The mapping could not be saved; `remediationHint` says how to finish with `sonar link`. */
export class MappingWriteError extends CommandFailedError {
  constructor(message: string, remediationHint: string) {
    super(message, { remediationHint });
    this.name = 'MappingWriteError';
  }
}

const PROJECT_ORIGIN_LEAD = { created: 'Created', found: 'Found' } as const;

/** The project already exists on the server by now, so a failure here has to say how to finish. */
export async function writeMapping(
  auth: ResolvedAuth,
  projectKey: string,
  projectRoot: string,
  console: Console,
  origin: keyof typeof PROJECT_ORIGIN_LEAD,
): Promise<void> {
  const { gitRoot, isGit } = findGitRoot(projectRoot);
  const configDir = canonicalizePath(isGit ? gitRoot : projectRoot);
  const path = relative(configDir, projectRoot).split(sep).join('/') || '.';
  const entry = deriveEntry(auth, projectKey, path);

  try {
    const mapped = await sharedProjectConfigRepository.load(configDir);
    const replaced = mapped.find(
      (mapping) => canonicalizePath(mapping.projectRoot) === canonicalizePath(projectRoot),
    );
    if (replaced) {
      console.warn(
        `Replacing the mapping of this directory to '${replaced.projectKey}' in ${SHARED_PROJECT_CONFIG_FILE_NAME}.`,
      );
    }
    const shadowed = await sharedProjectConfigRepository.set(configDir, entry);
    if (shadowed) {
      console.warn(
        `${SHARED_PROJECT_CONFIG_FILE_NAME} contains a projects array, which takes precedence over the project entry just written, so the link was saved but is ignored.`,
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const cwdRoot = findGitRoot(process.cwd());
    const linkRoot = canonicalizePath(cwdRoot.isGit ? cwdRoot.gitRoot : process.cwd());
    const runFrom = linkRoot === configDir ? undefined : configDir;
    throw new MappingWriteError(
      `${PROJECT_ORIGIN_LEAD[origin]} project '${projectKey}', but could not save ${SHARED_PROJECT_CONFIG_FILE_NAME}: ${reason}`,
      `Fix the file, then map the project by running:\n  ${linkCommand(projectKey, path, runFrom)}`,
    );
  }
}

export function projectDashboardUrl(auth: ResolvedAuth, projectKey: string): string {
  return `${auth.serverUrl.replace(/\/$/, '')}/project/overview?id=${encodeURIComponent(projectKey)}`;
}

export async function showAnalysisResults(
  api: SonarHttpClient,
  projectKey: string,
  dashboardUrl: string,
  console: Console,
  noResultsNote: string,
): Promise<void> {
  const status = await new QualityGatesClient(api).getProjectStatus({ projectKey }).match(
    (value) => value?.status ?? 'NONE',
    (error) => {
      logger.debug(`Could not read the quality gate of '${projectKey}': ${error.message}`);
      return 'UNKNOWN' as const;
    },
  );
  if (status === 'UNKNOWN') {
    console.print('Could not fetch the analysis results.');
  } else if (status === 'NONE') {
    console.print(noResultsNote);
  } else {
    console.print(
      `Quality gate: ${status === 'OK' ? 'passed' : 'failed'}. See: sonar quality-gate status -p ${projectKey}`,
    );
  }
  console.print(`Project dashboard: ${dashboardUrl}`);
}

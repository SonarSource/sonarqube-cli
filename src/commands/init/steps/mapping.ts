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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { SHARED_PROJECT_CONFIG_FILE_NAME } from '@/core/config-constants.ts';
import { shellQuote } from '@/core/host/shell-quote.ts';
import logger from '@/core/observability/logger.ts';
import {
  linkItem,
  relativeProjectPath,
  resolveConfigDir,
  resolveProjectTarget,
  withLink,
} from '@/core/project-discovery/link-target.ts';
import {
  InvalidSharedProjectConfigError,
  sharedProjectConfigFile,
  throwOnInvalidConfig,
} from '@/core/project-discovery/shared-project-config.ts';
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

/**
 * The `sonar link` command that maps `projectKey` the way `sonar init` would, prefixed with a `cd`
 * when it has to run from another repository than the current directory's.
 */
export async function linkCommandFor(projectKey: string, projectRoot: string): Promise<string> {
  const { targetDir } = await resolveProjectTarget(projectRoot);
  const { targetDir: linkRoot } = await resolveConfigDir(process.cwd());
  return linkCommand(
    projectKey,
    relativeProjectPath(targetDir, projectRoot),
    linkRoot === targetDir ? undefined : targetDir,
  );
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
  const target = await resolveProjectTarget(projectRoot);

  try {
    // Only this directory's link is set, so onboarding one directory never drops the others.
    const items = await sharedProjectConfigFile.readItems(target.targetDir, throwOnInvalidConfig);
    const item = linkItem(auth, target.targetDir, target.projectRoot, projectKey);
    const replaced = items.find((existing) => existing.root === item.root);
    await sharedProjectConfigFile.writeItems(target.targetDir, withLink(items, item));
    const replacedKey = replaced?.entry.projectKey;
    if (replacedKey !== undefined) {
      console.warn(
        `Replacing the mapping of this directory to '${replacedKey}' in ${SHARED_PROJECT_CONFIG_FILE_NAME}.`,
      );
    }
  } catch (error) {
    // A config file that cannot be read is a failed save, so it gets the `sonar link` hint below.
    if (
      error instanceof CommandFailedError &&
      !(error instanceof InvalidSharedProjectConfigError)
    ) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new MappingWriteError(
      `${PROJECT_ORIGIN_LEAD[origin]} project '${projectKey}', but could not save ${SHARED_PROJECT_CONFIG_FILE_NAME}: ${reason}`,
      `Fix the file, then map the project by running:\n  ${await linkCommandFor(projectKey, projectRoot)}`,
    );
  }
}

export function reportProjectCreated(console: Console, projectKey: string): void {
  console.success(`Created project '${projectKey}' and saved ${SHARED_PROJECT_CONFIG_FILE_NAME}.`);
}

export function serverBaseUrl(auth: ResolvedAuth): string {
  return auth.serverUrl.replace(/\/$/, '');
}

export function projectDashboardUrl(auth: ResolvedAuth, projectKey: string): string {
  return `${serverBaseUrl(auth)}/project/overview?id=${encodeURIComponent(projectKey)}`;
}

export async function showAnalysisResults(
  api: SonarHttpClient,
  projectKey: string,
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
}

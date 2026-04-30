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
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

import type { Command } from 'commander';

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import { normalizePath } from '../../../lib/fs-utils';
import logger from '../../../lib/logger';
import { loadState } from '../../../lib/repository/state-repository';
import type { HookExtension } from '../../../lib/state';
import { findExtensionsByProject } from '../../../lib/state-manager';
import type { SqaaIssue } from '../../../sonarqube/client';
import { SonarQubeClient } from '../../../sonarqube/client';
import { blank, error, success, text, warn } from '../../../ui';
import { CommandFailedError, InvalidOptionError } from '../_common/error.js';

export interface AnalyzeSqaaOptions {
  file: string;
  branch?: string;
  project?: string;
}

export async function analyzeSqaa(
  options: AnalyzeSqaaOptions,
  auth: ResolvedAuth,
  command?: Command,
): Promise<void> {
  const { file, branch, project } = options;

  if (!existsSync(file)) {
    throw new InvalidOptionError(`File not found: ${file}`);
  }

  await runSqaaAnalysis(file, auth, branch, project, command);
}

export async function runSqaaAnalysis(
  file: string,
  auth: ResolvedAuth,
  branch?: string,
  explicitProject?: string,
  command?: Command,
): Promise<void> {
  const cloudAuth = resolveCloudAuth(auth, explicitProject);
  if (!cloudAuth) {
    warn(
      'SonarQube Agentic Analysis skipped: a SonarQube Cloud connection is required. Run: sonar auth login (ensure you connect to SonarQube Cloud)',
    );
    return;
  }

  const projectKey = explicitProject ?? resolveSqaaProjectKey(command);
  if (!projectKey) {
    warn(
      'SonarQube Agentic Analysis skipped: no project configured. Specify one with --project or run: sonar integrate claude',
    );
    return;
  }

  const fileContent = readSqaaFileContent(file);
  await callSqaaApiAndDisplay(cloudAuth, projectKey, file, fileContent, branch);
}

/**
 * Validate that the resolved auth is for SonarQube Cloud.
 * Returns null when the connection is not Cloud and --project is not set.
 * Throws CommandFailedError when --project is set but the connection is not Cloud.
 */
function resolveCloudAuth(
  auth: ResolvedAuth,
  explicitProject: string | undefined,
): { serverUrl: string; token: string; orgKey: string } | null {
  if (auth.connectionType != 'cloud' || auth.orgKey == null) {
    if (explicitProject) {
      throw new CommandFailedError(
        'SonarQube Agentic Analysis requires a SonarQube Cloud connection. Run: sonar auth login',
      );
    }
    logger.debug('SonarQube Agentic Analysis skipped: missing orgKey or on-premise server');
    return null;
  }

  return { serverUrl: auth.serverUrl, token: auth.token, orgKey: auth.orgKey };
}

/**
 * Look up the project key for the current directory from the agentExtensions registry.
 * Returns null when SQAA should be skipped.
 */
function resolveSqaaProjectKey(command?: Command): string | null {
  try {
    const state = loadState();
    const extensions = findExtensionsByProject(state, 'claude-code', process.cwd());
    const sqaaExt = extensions.find(
      (e): e is HookExtension => e.kind === 'hook' && e.name === 'sonar-sqaa',
    );

    if (!sqaaExt?.projectKey) {
      logger.debug(
        'SonarQube Agentic Analysis skipped: no project key found in extensions registry',
      );
      if (process.stdin.isTTY) {
        command?.outputHelp();
      }
      return null;
    }

    return sqaaExt.projectKey;
  } catch {
    logger.debug('SonarQube Agentic Analysis skipped: failed to resolve extensions');
    return null;
  }
}

/**
 * Read file content for SQAA analysis.
 * Throws CommandFailedError when the file cannot be read.
 */
function readSqaaFileContent(file: string): string {
  try {
    return readFileSync(file, 'utf-8');
  } catch (err) {
    throw new CommandFailedError(`Failed to read file: ${(err as Error).message}`);
  }
}

/**
 * Compute a POSIX-style relative path under the current working directory.
 * Throws when the file is outside cwd (traversal) or on a different drive.
 */
function toRelativePosixPath(file: string): string {
  const rel = normalizePath(relative(process.cwd(), file));

  if (isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new InvalidOptionError(`File must be inside the current working directory: ${file}`);
  }

  return rel;
}

/**
 * Call the SQAA API and display the results.
 * Throws CommandFailedError on API failure.
 */
async function callSqaaApiAndDisplay(
  auth: { serverUrl: string; token: string; orgKey: string },
  projectKey: string,
  file: string,
  fileContent: string,
  branch: string | undefined,
): Promise<void> {
  const filePath = toRelativePosixPath(file);
  const client = new SonarQubeClient(auth.serverUrl, auth.token);

  blank();
  text('Running SonarQube Agentic Analysis...');

  try {
    const response = await client.analyzeFile({
      organizationKey: auth.orgKey,
      projectKey,
      ...(branch ? { branchName: branch } : {}),
      filePath,
      fileContent,
    });

    displaySqaaResults(response.issues, response.errors);
  } catch (err) {
    throw new CommandFailedError(`SonarQube Agentic Analysis failed.\n  ${(err as Error).message}`);
  }
}

function displaySqaaResults(
  issues: SqaaIssue[],
  errors?: Array<{ code: string; message: string }> | null,
): void {
  blank();

  if (issues.length === 0) {
    success('SonarQube Agentic Analysis completed — no issues found.');
  } else {
    error(
      `SonarQube Agentic Analysis found ${issues.length} issue${issues.length === 1 ? '' : 's'}:`,
    );
    blank();
    issues.forEach((issue, idx) => {
      const location = issue.textRange ? ` (line ${issue.textRange.startLine})` : '';
      text(`  [${idx + 1}] ${issue.message}${location}`);
      text(`      Rule: ${issue.rule}`);
    });
  }

  if (errors && errors.length > 0) {
    blank();
    error('SonarQube Agentic Analysis returned errors:');
    errors.forEach((e) => {
      text(`  [${e.code}] ${e.message}`);
    });
  }

  blank();
}

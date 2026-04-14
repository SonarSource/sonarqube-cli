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
import { isAbsolute, relative, resolve } from 'node:path';
import type { Command } from 'commander';
import type { ResolvedAuth } from '../../../lib/auth-resolver';
import { normalizePath } from '../../../lib/fs-utils';
import logger from '../../../lib/logger';
import { blank, error, success, text } from '../../../ui';
import { CommandFailedError, InvalidOptionError } from '../_common/error.js';
import { SonarQubeClient } from '../../../sonarqube/client';
import type { SqaaIssue } from '../../../sonarqube/client';
import { loadState, findExtensionsByProject } from '../../../lib/state-manager';
import type { HookExtension } from '../../../lib/state';
import { spawnProcess } from '../../../lib/process';

export interface AnalyzeSqaaOptions {
  file?: string;
  staged?: boolean;
  base?: string;
  branch?: string;
  project?: string;
}

export async function analyzeSqaa(
  options: AnalyzeSqaaOptions,
  auth: ResolvedAuth,
  command?: Command,
): Promise<void> {
  const { file, staged, base, branch, project } = options;

  if (staged && base !== undefined) {
    throw new InvalidOptionError('--staged and --base cannot be used together');
  }

  if (file) {
    if (!existsSync(file)) {
      throw new InvalidOptionError(`File not found: ${file}`);
    }
    await runSqaaAnalysis(file, auth, branch, project, command);
  } else {
    await analyzeSqaaChangeSet({ staged, base, branch, project }, auth, command);
  }
}

interface ChangeSetOptions {
  staged?: boolean;
  base?: string;
  branch?: string;
  project?: string;
}

async function analyzeSqaaChangeSet(
  options: ChangeSetOptions,
  auth: ResolvedAuth,
  command: Command | undefined,
): Promise<void> {
  const { staged, base, branch, project } = options;

  const cloudAuth = resolveCloudAuth(auth, project);
  if (!cloudAuth) return;

  const projectKey = project ?? resolveSqaaProjectKey(command);
  if (!projectKey) return;

  const files = await getChangedFiles({ staged, base });

  if (files.length === 0) {
    blank();
    success('No changes detected since last commit.');
    return;
  }

  blank();
  text(`Analyzing ${files.length} changed file(s)...`);

  let totalIssues = 0;
  for (const relFile of files) {
    const absFile = resolve(process.cwd(), relFile);
    try {
      const fileContent = readSqaaFileContent(absFile);
      const issueCount = await callSqaaApiAndDisplay(
        cloudAuth,
        projectKey,
        absFile,
        fileContent,
        branch,
        relFile,
      );
      totalIssues += issueCount;
    } catch (err) {
      blank();
      error(`Failed to analyze ${relFile}: ${(err as Error).message}`);
    }
  }

  blank();
  if (totalIssues === 0) {
    success('Changeset is clean! No new issues introduced.');
  } else {
    process.exitCode = 1;
  }
}

async function getChangedFiles(options: { staged?: boolean; base?: string }): Promise<string[]> {
  if (options.staged) {
    const result = await spawnProcess('git', [
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=ACMR',
    ]);
    return result.stdout.split('\n').filter(Boolean);
  }

  const baseRef = options.base ?? 'HEAD';
  const [changed, untracked] = await Promise.all([
    spawnProcess('git', ['diff', baseRef, '--name-only', '--diff-filter=ACMR']),
    spawnProcess('git', ['ls-files', '--others', '--exclude-standard']),
  ]);

  const seen = new Set<string>();
  const files: string[] = [];
  for (const line of [...changed.stdout.split('\n'), ...untracked.stdout.split('\n')]) {
    const f = line.trim();
    if (f && !seen.has(f)) {
      seen.add(f);
      files.push(f);
    }
  }
  return files;
}

export async function runSqaaAnalysis(
  file: string,
  auth: ResolvedAuth,
  branch?: string,
  explicitProject?: string,
  command?: Command,
): Promise<void> {
  const cloudAuth = resolveCloudAuth(auth, explicitProject);
  if (!cloudAuth) return;

  const projectKey = explicitProject ?? resolveSqaaProjectKey(command);
  if (!projectKey) return;

  const fileContent = readSqaaFileContent(file);
  await callSqaaApiAndDisplay(cloudAuth, projectKey, file, fileContent, branch);
}

/**
 * Validate that the resolved auth is for SonarQube Cloud.
 * Returns null when SQAA should be silently skipped (on-premise or missing orgKey without --project).
 * Throws CommandFailedError when --project is set but the connection is not Cloud.
 */
function resolveCloudAuth(
  auth: ResolvedAuth,
  explicitProject: string | undefined,
): { serverUrl: string; token: string; orgKey: string } | null {
  if (auth.connectionType != 'cloud' || auth.orgKey == null) {
    if (explicitProject) {
      throw new CommandFailedError(
        'SQAA analysis requires a SonarQube Cloud connection. Run: sonar auth login',
      );
    }
    logger.debug('SQAA analysis skipped: missing orgKey or on-premise server');
    return null;
  }

  return { serverUrl: auth.serverUrl, token: auth.token, orgKey: auth.orgKey };
}

/**
 * Look up the project key for the current directory from the agentExtensions registry.
 * Returns null when SQAA should be silently skipped.
 */
function resolveSqaaProjectKey(command?: Command): string | null {
  try {
    const state = loadState();
    const extensions = findExtensionsByProject(state, 'claude-code', process.cwd());
    const sqaaExt = extensions.find(
      (e): e is HookExtension => e.kind === 'hook' && e.name === 'sonar-sqaa',
    );

    if (!sqaaExt?.projectKey) {
      logger.debug('SQAA analysis skipped: no project key found in extensions registry');
      if (process.stdin.isTTY) {
        command?.outputHelp();
      }
      return null;
    }

    return sqaaExt.projectKey;
  } catch {
    logger.debug('SQAA analysis skipped: failed to resolve extensions');
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
 * When fileLabel is provided, it is printed as a section header before results.
 */
async function callSqaaApiAndDisplay(
  auth: { serverUrl: string; token: string; orgKey: string },
  projectKey: string,
  file: string,
  fileContent: string,
  branch: string | undefined,
  fileLabel?: string,
): Promise<number> {
  const filePath = toRelativePosixPath(file);
  const client = new SonarQubeClient(auth.serverUrl, auth.token);

  blank();
  if (fileLabel) {
    text(`── ${fileLabel}`);
  }
  text('Running SQAA analysis...');

  try {
    const response = await client.analyzeFile({
      organizationKey: auth.orgKey,
      projectKey,
      ...(branch ? { branchName: branch } : {}),
      filePath,
      fileContent,
    });

    return displaySqaaResults(response.issues, response.errors, fileLabel !== undefined);
  } catch (err) {
    throw new CommandFailedError(`SQAA analysis failed.\n  ${(err as Error).message}`);
  }
}

function displaySqaaResults(
  issues: SqaaIssue[],
  errors?: Array<{ code: string; message: string }> | null,
  inChangeSetMode = false,
): number {
  blank();

  if (issues.length === 0) {
    if (!inChangeSetMode) {
      success('SQAA analysis completed — no issues found.');
    }
  } else {
    error(`SQAA analysis found ${issues.length} issue${issues.length === 1 ? '' : 's'}:`);
    blank();
    issues.forEach((issue, idx) => {
      const location = issue.textRange ? ` (line ${issue.textRange.startLine})` : '';
      text(`  [${idx + 1}] ${issue.message}${location}`);
      text(`      Rule: ${issue.rule}`);
    });
  }

  if (errors && errors.length > 0) {
    blank();
    error('SQAA analysis returned errors:');
    errors.forEach((e) => {
      text(`  [${e.code}] ${e.message}`);
    });
  }

  blank();
  return issues.length;
}

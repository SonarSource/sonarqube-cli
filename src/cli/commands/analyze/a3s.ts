/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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
import { relative } from 'node:path';
import type { Command } from 'commander';
import { resolveAuth } from '../../../lib/auth-resolver';
import logger from '../../../lib/logger';
import { blank, error, success, text } from '../../../ui';
import { CommandFailedError, InvalidOptionError } from '../_common/error.js';
import { SonarQubeClient } from '../../../sonarqube/client';
import type { A3sIssue } from '../../../sonarqube/client';
import { loadState, findExtensionsByProject } from '../../../lib/state-manager';
import type { HookExtension } from '../../../lib/state';

export interface AnalyzeA3sOptions {
  file: string;
  branch?: string;
  project?: string;
}

export async function analyzeA3s(options: AnalyzeA3sOptions, command?: Command): Promise<void> {
  const { file, branch, project } = options;

  if (!existsSync(file)) {
    throw new InvalidOptionError(`File not found: ${file}`);
  }

  await runA3sAnalysis(file, branch, project, command);
}

export async function runA3sAnalysis(
  file: string,
  branch?: string,
  explicitProject?: string,
  command?: Command,
): Promise<void> {
  const auth = await resolveCloudAuth(explicitProject);
  if (!auth) return;

  const projectKey = explicitProject ?? resolveA3sProjectKey(command);
  if (!projectKey) return;

  const fileContent = readA3sFileContent(file);
  await callA3sApiAndDisplay(auth, projectKey, file, fileContent, branch);
}

/**
 * Resolve auth and validate that the connection is SonarQube Cloud.
 * Returns null when A3S should be silently skipped (no auth / on-premise without --project).
 * Throws CommandFailedError when --project is set but the connection is not Cloud.
 */
async function resolveCloudAuth(
  explicitProject: string | undefined,
): Promise<{ serverUrl: string; token: string; orgKey: string } | null> {
  let auth;
  try {
    auth = await resolveAuth({});
  } catch {
    logger.debug('A3S analysis skipped: failed to resolve auth');
    return null;
  }

  if (!auth.token || !auth.orgKey || auth.connectionType === 'on-premise') {
    if (explicitProject) {
      throw new CommandFailedError(
        'A3S analysis requires a SonarQube Cloud connection. Run: sonar auth login',
      );
    }
    logger.debug('A3S analysis skipped: no auth, missing orgKey, or on-premise server');
    return null;
  }

  return { serverUrl: auth.serverUrl, token: auth.token, orgKey: auth.orgKey };
}

/**
 * Look up the project key for the current directory from the agentExtensions registry.
 * Returns null when A3S should be silently skipped.
 */
function resolveA3sProjectKey(command?: Command): string | null {
  try {
    const state = loadState();
    const extensions = findExtensionsByProject(state, 'claude-code', process.cwd());
    const a3sExt = extensions.find(
      (e): e is HookExtension => e.kind === 'hook' && e.name === 'sonar-a3s',
    );

    if (!a3sExt?.projectKey) {
      logger.debug('A3S analysis skipped: no project key found in extensions registry');
      if (process.stdin.isTTY) {
        command?.outputHelp();
      }
      return null;
    }

    return a3sExt.projectKey;
  } catch {
    logger.debug('A3S analysis skipped: failed to resolve extensions');
    return null;
  }
}

/**
 * Read file content for A3S analysis.
 * Throws CommandFailedError when the file cannot be read.
 */
function readA3sFileContent(file: string): string {
  try {
    return readFileSync(file, 'utf-8');
  } catch (err) {
    throw new CommandFailedError(`Failed to read file: ${(err as Error).message}`);
  }
}

/**
 * Call the A3S API and display the results.
 * Throws CommandFailedError on API failure.
 */
async function callA3sApiAndDisplay(
  auth: { serverUrl: string; token: string; orgKey: string },
  projectKey: string,
  file: string,
  fileContent: string,
  branch: string | undefined,
): Promise<void> {
  const filePath = relative(process.cwd(), file);
  const client = new SonarQubeClient(auth.serverUrl, auth.token);

  blank();
  text('Running A3S analysis...');

  try {
    const response = await client.analyzeFile({
      organizationKey: auth.orgKey,
      projectKey,
      ...(branch ? { branchName: branch } : {}),
      filePath,
      fileContent,
    });

    displayA3sResults(response.issues, response.errors);
  } catch (err) {
    logger.error(`A3S analysis failed: ${(err as Error).message}`);
    blank();
    error('A3S analysis failed.');
    text(`  ${(err as Error).message}`);
    blank();
    throw new CommandFailedError('A3S analysis failed');
  }
}

function displayA3sResults(
  issues: A3sIssue[],
  errors?: Array<{ code: string; message: string }> | null,
): void {
  if (errors && errors.length > 0) {
    blank();
    error('A3S analysis returned errors:');
    errors.forEach((e) => {
      text(`  [${e.code}] ${e.message}`);
    });
    blank();
    return;
  }

  blank();
  if (issues.length === 0) {
    success('A3S analysis completed — no issues found.');
  } else {
    error(`A3S analysis found ${issues.length} issue${issues.length === 1 ? '' : 's'}:`);
    blank();
    issues.forEach((issue, idx) => {
      const location = issue.textRange ? ` (line ${issue.textRange.startLine})` : '';
      text(`  [${idx + 1}] ${issue.message}${location}`);
      text(`      Rule: ${issue.rule}`);
    });
  }
  blank();
}

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

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { installSonarScanner } from '@/core/host/install/sonar-scanner.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import { discoverProject } from '@/core/project-info.ts';
import { isSonarQubeCloud } from '@/core/server/sonarcloud-region.ts';
import type { IssuesSearchResponse } from '@/core/server/types.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';
import type { Console } from '@/core/ui/console.ts';

import { DEFAULT_STATUSES } from '../list/issues.ts';
import { OnboardApiClient, type OnboardVisibility } from './onboard-api.ts';
import { ONBOARD_ISSUES_PAGE_SIZE, printOnboardReport, resolveOnboardFormat } from './output.ts';
import { OnboardProgressConsole } from './progress-console.ts';
import { generateProjectTarget } from './project-key.ts';
import { runFirstAnalysis } from './scanner.ts';
import { scannerNetworkEnv } from './scanner-network.ts';

export interface OnboardOptions {
  projectKey?: string;
  path?: string;
  name?: string;
  visibility?: string;
  format?: string;
  verbose?: boolean;
}

function resolveSourcePath(path: string | undefined): string {
  if (path === undefined) return process.cwd();
  if (!path.trim()) throw new InvalidOptionError('--path must not be empty.');
  const directory = resolve(path);
  try {
    if (statSync(directory).isDirectory()) return canonicalizePath(directory);
  } catch {
    // Missing or inaccessible directories are invalid invocation targets.
  }
  throw new InvalidOptionError(`--path must point to an existing directory: '${path}'.`);
}

function validateProjectName(name: string): string {
  if (!name.trim() || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new InvalidOptionError(
      '--name must be non-empty and must not contain control characters.',
    );
  }
  return name.trim();
}

function resolveVisibility(visibility: string | undefined): OnboardVisibility {
  if (visibility === undefined) return 'private';
  if (visibility === 'private' || visibility === 'public') return visibility;
  throw new InvalidOptionError('--visibility must be private or public.');
}

function validateProjectKey(key: string): string {
  if (!key || !/^[a-zA-Z0-9._:-]+$/.test(key) || /^\d+$/.test(key)) {
    throw new InvalidOptionError(
      '--project-key must contain only letters, digits, ".", "_", "-", or ":" and cannot be entirely numeric.',
    );
  }
  return key;
}

function assertSupportedBuild(projectRoot: string): void {
  const files = readdirSync(projectRoot);
  let scanner: string | undefined;
  if (existsSync(join(projectRoot, 'pom.xml'))) scanner = 'Maven';
  else if (
    files.some((name) =>
      ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].includes(name),
    )
  )
    scanner = 'Gradle';
  else if (files.some((name) => /\.(slnx?|csproj|vbproj|fsproj)$/i.test(name))) scanner = '.NET';
  if (scanner)
    throw new CommandFailedError(`This project requires SonarScanner for ${scanner}.`, {
      remediationHint: `Use the dedicated SonarScanner for ${scanner} to create its first analysis.`,
    });
}

async function resolveTarget(
  options: OnboardOptions,
  ctx: CommandAuthenticatedInvocationContext,
  progress: Console,
): Promise<{ projectKey: string; projectRoot: string; projectName: string }> {
  const sourceRoot = resolveSourcePath(options.path);
  if (options.projectKey !== undefined)
    return {
      projectKey: validateProjectKey(options.projectKey),
      projectRoot: sourceRoot,
      projectName: basename(sourceRoot),
    };
  const project = await discoverProject(sourceRoot, {
    auth: null,
    useKnownMappings: false,
    silent: true,
    console: progress,
  });
  if (!project.projectKey) {
    const target = await generateProjectTarget(
      project.projectRoot,
      project.repoRoot,
      ctx.auth.orgKey,
      options.path !== undefined,
    );
    progress.info(`Generated project key '${target.projectKey}' for '${target.projectName}'.`);
    return target;
  }
  if (
    (project.serverUrl &&
      project.serverUrl.replace(/\/$/, '') !== ctx.auth.serverUrl.replace(/\/$/, '')) ||
    (project.organization && project.organization !== ctx.auth.orgKey)
  ) {
    throw new CommandFailedError(
      'The detected project configuration does not match the active connection.',
      {
        remediationHint:
          'Log in to the matching server and organization, or supply --project-key explicitly.',
      },
    );
  }
  progress.info(`Using project key '${project.projectKey}' from project configuration.`);
  return {
    projectKey: validateProjectKey(project.projectKey),
    projectRoot: options.path !== undefined ? sourceRoot : project.projectRoot,
    projectName: basename(options.path !== undefined ? sourceRoot : project.projectRoot),
  };
}

export async function onboard(
  options: OnboardOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { console } = ctx;
  const format = resolveOnboardFormat(options.format);
  const wasFormatted = console.isFormattedOutputMode();
  console.setFormattedOutputMode(format === 'json');
  try {
    await runOnboarding(options, ctx, format);
  } finally {
    console.setFormattedOutputMode(wasFormatted);
  }
}

async function runOnboarding(
  options: OnboardOptions,
  ctx: CommandAuthenticatedInvocationContext,
  format: 'text' | 'json',
): Promise<void> {
  const { auth, console } = ctx;
  const progress = new OnboardProgressConsole(console, format);
  const visibility = resolveVisibility(options.visibility);
  const requestedName = options.name !== undefined ? validateProjectName(options.name) : undefined;
  const target = await resolveTarget(options, ctx, progress);
  const { projectKey, projectRoot } = target;
  const projectName = requestedName ?? target.projectName;
  if ((auth.connectionType === 'cloud' || isSonarQubeCloud(auth.serverUrl)) && !auth.orgKey) {
    throw new CommandFailedError('A SonarQube Cloud organization is required for onboarding.', {
      remediationHint: 'Run sonar auth login --org <organization> first.',
    });
  }
  const api = new OnboardApiClient(ctx.connection.httpClient);
  const dashboard = `${auth.serverUrl.replace(/\/$/, '')}/dashboard?id=${encodeURIComponent(projectKey)}`;
  const existingProject = await api.components.getComponent(projectKey).orThrow();
  if (existingProject) {
    progress.warn(
      `Project '${projectKey}' already exists. Onboarding skipped; no analysis was run.`,
    );
    printOnboardReport(
      {
        projectKey,
        projectName: existingProject.name ?? projectName,
        analysis: { status: 'skipped', id: null },
        qualityGate: null,
        dashboardUrl: dashboard,
        issues: null,
        paging: null,
        scannerLogPath: null,
        messages: console.getMessagesForFormattedOutput(),
        warnings: progress.warnings,
      },
      format,
      console,
    );
    return;
  }
  assertSupportedBuild(projectRoot);

  const scanner = await installSonarScanner(progress);
  const directory = mkdtempSync(join(tmpdir(), 'sonar-onboard-'));
  let created = false;
  try {
    const networkEnv = await scannerNetworkEnv(auth.serverUrl, scanner.javaPath, directory);
    await api.createProject(projectKey, projectName, auth.orgKey, visibility).orThrow();
    created = true;
    noteProject(auth, projectKey);
    progress.success(`Created ${visibility} unbound project '${projectKey}'.`);
    const scan = () =>
      runFirstAnalysis(
        scanner,
        projectRoot,
        projectKey,
        auth,
        directory,
        networkEnv,
        options.verbose ? { console, channel: format === 'json' ? 'stderr' : 'stdout' } : undefined,
        requestedName,
      );
    if (options.verbose) progress.info('Analyzing source code');
    const { taskId, logPath, stdout, stderr } = options.verbose
      ? await scan()
      : await progress.withSpinner('Analyzing source code', scan);
    progress.success('Analysis uploaded.');
    const analysisId = await progress.withSpinner('Waiting for analysis processing', () =>
      api.waitForAnalysis(taskId, projectKey),
    );
    progress.success('Analysis processed.');
    const warnings = progress.warnings;
    let gate: string | null = null;
    let issueResult: IssuesSearchResponse | null = null;
    try {
      gate = await api.qualityGate(analysisId);
    } catch (error) {
      progress.warn(
        `Could not retrieve the quality gate: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      issueResult = await api.issues
        .searchIssues({
          projects: projectKey,
          organization: auth.orgKey,
          issueStatuses: DEFAULT_STATUSES.join(','),
          ps: ONBOARD_ISSUES_PAGE_SIZE,
          p: 1,
        })
        .orThrow();
    } catch (error) {
      progress.warn(
        `Could not retrieve issues: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    printOnboardReport(
      {
        projectKey,
        projectName,
        analysis: { status: 'completed', id: analysisId },
        qualityGate: gate,
        dashboardUrl: dashboard,
        issues: issueResult?.issues ?? null,
        paging: issueResult?.paging ?? null,
        scannerLogPath: logPath,
        ...(options.verbose ? { scannerOutput: { stdout, stderr } } : {}),
        messages: console.getMessagesForFormattedOutput(),
        warnings,
      },
      format,
      console,
    );
  } catch (cause) {
    if (!created) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new CommandFailedError(
      `Project '${projectKey}' was created, but its first analysis could not be completed: ${message}\nThe project and scanner installation have been retained. Full results: ${dashboard}`,
      {
        cause,
        remediationHint: `The project and scanner installation have been retained. Check ${dashboard} and rerun the scanner from ${scanner.home} after resolving the error.`,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

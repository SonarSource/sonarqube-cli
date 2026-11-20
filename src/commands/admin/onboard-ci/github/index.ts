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

import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { GitHubClient, GitHubRepo } from '@/core/github/client.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import type { Console } from '@/core/ui/console.ts';

import { resolveGithubDopSetting } from '../dop-setting.ts';
import {
  assertOnPremiseConnection,
  DRY_RUN_REPORT_FILE,
  readOptionFile,
  readReposFile,
  REPORT_FILE,
  runWithRepoProgress,
  writeReportFile,
} from '../shared.ts';
import { OnboardCiSqsClient } from '../sqs-api.ts';
import type {
  FailedResult,
  OnboardCiOptions,
  OnboardCiResults,
  OpenedResult,
  RepoProject,
  SkippedResult,
} from '../types.ts';
import type { ProcessRepoContext } from './processor.ts';
import { assessRepo, executeRepo } from './processor.ts';
import type { WorkflowOptions } from './templates.ts';
import { validateWorkflowOptions } from './templates.ts';

export interface OnboardCiGithubOptions extends OnboardCiOptions, WorkflowOptions {
  org: string;
  workflowTemplate?: string;
}

type GithubResults = OnboardCiResults<OpenedResult, SkippedResult>;

interface DryRunResults {
  wouldOpenPr: RepoProject[];
  wouldSkip: SkippedResult[];
  failed: FailedResult[];
}

export function validateOnboardCiGithubOptions(
  options: OnboardCiGithubOptions,
): string | undefined {
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(options.org)) {
    throw new InvalidOptionError('Invalid --org value. Provide a GitHub organization name.');
  }
  const template =
    options.workflowTemplate === undefined
      ? undefined
      : readOptionFile(options.workflowTemplate, '--workflow-template');
  validateWorkflowOptions(options, template);
  return template;
}

function filterRepos(repos: GitHubRepo[], path: string, console: Console): GitHubRepo[] {
  const entries = readReposFile(path);
  for (const entry of entries) {
    if (!repos.some((repo) => repo.name === entry || repo.full_name === entry)) {
      console.warn(`→ '${entry}' from --repos-file not found in organization, skipped`);
    }
  }
  return repos.filter((repo) => entries.has(repo.name) || entries.has(repo.full_name));
}

async function runDryRun(
  ctx: ProcessRepoContext,
  repos: GitHubRepo[],
  bindings: ReadonlyMap<string, string>,
  console: Console,
): Promise<DryRunResults> {
  const results: DryRunResults = { wouldOpenPr: [], wouldSkip: [], failed: [] };
  await runWithRepoProgress(
    repos,
    (repo) => repo.full_name,
    async (repo, progress) => {
      const name = repo.full_name;
      const github = ctx.github.withRetryHandler((message) => {
        progress.warn(`${name}: ${message}`);
      });
      const result = await assessRepo({ ...ctx, github }, repo, bindings);
      switch (result.outcome) {
        case 'proceed':
          results.wouldOpenPr.push({ repo: name, projectKey: result.projectKey });
          progress.update(name, 'done', 'would open PR');
          break;
        case 'skip':
          results.wouldSkip.push({ repo: name, reason: result.reason, prUrl: result.prUrl });
          progress.update(name, 'done', result.reason);
          break;
        case 'failed':
          results.failed.push({ repo: name, error: result.error });
          progress.update(name, 'failed', result.error);
          break;
      }
    },
    console,
  );
  return results;
}

async function runLive(
  ctx: ProcessRepoContext,
  repos: GitHubRepo[],
  bindings: ReadonlyMap<string, string>,
  console: Console,
): Promise<GithubResults> {
  const results: GithubResults = { opened: [], skipped: [], failed: [] };
  await runWithRepoProgress(
    repos,
    (repo) => repo.full_name,
    async (repo, progress) => {
      const name = repo.full_name;
      const github = ctx.github.withRetryHandler((message) => {
        progress.warn(`${name}: ${message}`);
      });
      const result = await executeRepo({ ...ctx, github }, repo, bindings);
      switch (result.outcome) {
        case 'opened':
          results.opened.push({ repo: name, projectKey: result.projectKey, prUrl: result.prUrl });
          progress.update(name, 'done', 'PR opened');
          break;
        case 'skip':
          results.skipped.push({ repo: name, reason: result.reason, prUrl: result.prUrl });
          progress.update(name, 'done', result.reason);
          break;
        case 'failed':
          results.failed.push({ repo: name, error: result.error });
          progress.update(name, 'failed', result.error);
          break;
      }
    },
    console,
  );
  return results;
}

export async function onboardCiGithub(
  connection: SonarConnection,
  github: GitHubClient,
  options: OnboardCiGithubOptions,
  console: Console,
  workflowTemplateContent?: string,
): Promise<void> {
  assertOnPremiseConnection(connection.auth, 'GitHub');
  const sqs = new OnboardCiSqsClient(connection.httpClient);
  const setting = await resolveGithubDopSetting(sqs.bindings, options.bindingName);

  console.intro('Onboard CI configuration', 'GitHub');
  if (options.dryRun) {
    console.info('DRY RUN: no changes will be made\n');
  }
  console.info(`Using GitHub configuration '${setting.key}' (${setting.url})`);
  console.info(`Processing organization: ${options.org}`);

  const bindings = await console.withSpinner('Fetching SonarQube project bindings...', () =>
    sqs.bindings.getAllProjectBindings(setting.id).orThrow(),
  );
  const allRepos = await console.withSpinner('Fetching GitHub repositories...', () =>
    github.listOrganizationRepos(options.org),
  );
  const repos = options.reposFile ? filterRepos(allRepos, options.reposFile, console) : allRepos;
  console.info(`Found ${repos.length.toLocaleString()} repositories to process`);

  const ctx: ProcessRepoContext = {
    github,
    components: sqs.components,
    serverUrl: connection.auth.serverUrl,
    options,
    workflowTemplate: workflowTemplateContent,
  };

  if (options.dryRun) {
    const results = await runDryRun(ctx, repos, bindings, console);
    const { wouldOpenPr, wouldSkip, failed } = results;
    console.outro(
      `Would open ${wouldOpenPr.length.toLocaleString()} PRs · ${wouldSkip.length.toLocaleString()} skipped · ${failed.length.toLocaleString()} failed`,
      failed.length ? 'error' : 'success',
      'No changes were made',
    );
    writeReportFile(results, DRY_RUN_REPORT_FILE, console);
    if (failed.length) {
      throw new CommandFailedError(`${failed.length} repositories failed to process.`, {
        remediationHint: 'See the per-repository errors above and the report file for details.',
      });
    }
    return;
  }

  const results = await runLive(ctx, repos, bindings, console);
  const { opened, skipped, failed } = results;
  console.outro(
    `Opened ${opened.length.toLocaleString()} PRs · ${skipped.length.toLocaleString()} skipped · ${failed.length.toLocaleString()} failed`,
    failed.length ? 'error' : 'success',
  );
  writeReportFile(results, REPORT_FILE, console);
  if (failed.length) {
    throw new CommandFailedError(`${failed.length} repositories failed to process.`, {
      remediationHint: 'See the per-repository errors above and the report file for details.',
    });
  }
}

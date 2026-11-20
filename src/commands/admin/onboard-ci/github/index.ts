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

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import type { GitHubClient, GitHubRepo } from '@/core/github/client.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import type { Console } from '@/core/ui/console.ts';

import { assertGithubComUrl, resolveDopSetting } from '../dop-setting.ts';
import {
  assertOnPremiseConnection,
  finishOnboarding,
  readOptionFile,
  readReposFile,
  runRepos,
} from '../shared.ts';
import { OnboardCiSqsClient } from '../sqs-api.ts';
import type { OnboardingTelemetry } from '../telemetry.ts';
import type { OnboardCiOptions } from '../types.ts';
import type { ProcessRepoContext } from './processor.ts';
import { assessRepo, executeRepo } from './processor.ts';
import type { WorkflowOptions } from './templates.ts';
import { validateWorkflowOptions } from './templates.ts';

export interface OnboardCiGithubOptions extends OnboardCiOptions, WorkflowOptions {
  org: string;
  workflowTemplate?: string;
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

export async function onboardCiGithub(
  connection: SonarConnection,
  github: GitHubClient,
  options: OnboardCiGithubOptions,
  console: Console,
  workflowTemplateContent?: string,
  telemetry: OnboardingTelemetry | null = null,
): Promise<void> {
  assertOnPremiseConnection(connection.auth, 'GitHub');
  const sqs = new OnboardCiSqsClient(connection.httpClient);
  const setting = await resolveDopSetting(sqs.bindings, 'github', options.bindingName);
  assertGithubComUrl(setting.url);

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

  const processRepo = options.dryRun ? assessRepo : executeRepo;
  const results = await runRepos(
    repos,
    (repo) => repo.full_name,
    (repo, progress) => {
      const github = ctx.github.withRetryHandler((message) => {
        progress.warn(`${repo.full_name}: ${message}`);
      });
      return processRepo({ ...ctx, github }, repo, bindings);
    },
    'PR',
    console,
    telemetry,
  );

  if (options.dryRun) {
    const dryRunResults = {
      wouldOpenPr: results.wouldOpen,
      wouldSkip: results.skipped,
      failed: results.failed,
    };
    finishOnboarding(results, dryRunResults, 'PR', console, true);
    return;
  }

  const { opened, skipped, failed } = results;
  finishOnboarding(results, { opened, skipped, failed }, 'PR', console);
}

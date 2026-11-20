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
import type { GitLabRepo } from '@/core/gitlab/client.ts';
import { GitLabClient } from '@/core/gitlab/client.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import type { Console } from '@/core/ui/console.ts';

import { resolveDopSetting } from '../dop-setting.ts';
import {
  assertOnPremiseConnection,
  finishOnboarding,
  readOptionFile,
  readReposFile,
  runRepos,
} from '../shared.ts';
import { OnboardCiSqsClient } from '../sqs-api.ts';
import type { OnboardingTelemetry } from '../telemetry.ts';
import type { ProcessRepoContext, RepoWithBranch } from './processor.ts';
import { assessRepo, executeRepo } from './processor.ts';
import { normalizeJobTemplate } from './templates.ts';
import type { OnboardCiGitlabInput, OnboardCiGitlabOptions } from './types.ts';
import { TriggerOn } from './types.ts';

// GitLab CI variable names: letters, digits, underscores only, no leading digit.
const GITLAB_VAR_NAME_RE = /^[a-zA-Z_]\w*$/;
// GitLab group paths: no whitespace, no leading/trailing slashes.
const GROUP_PATH_RE = /^[^\s/]([^\s]*[^\s/])?$/;
// GitLab stage names: alphanumeric, spaces, dots, underscores, hyphens — no YAML-significant characters.
const GITLAB_STAGE_NAME_RE = /^[a-zA-Z0-9 ._-]+$/;
// Scanner property key: starts with a letter, then letters/digits/dots/underscores/hyphens.
const SCANNER_PROPERTY_KEY_RE = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
// Scanner property value: must not be whitespace-only, contain newlines, ': ' (YAML mapping indicator), or ' #' (YAML comment).
const SCANNER_PROPERTY_VALUE_UNSAFE_RE = /[\n\r]|: | #/;

/** Flags whose value the job template takes over entirely; conflicting with --job-template. */
function assertNoJobShapeFlagsWithTemplate(options: OnboardCiGitlabOptions): void {
  const conflicts: string[] = [];
  if (options.stage !== undefined) conflicts.push('--stage');
  if (options.allowFailure) conflicts.push('--allow-failure');
  if (options.triggerOn !== TriggerOn.Both) conflicts.push('--trigger-on');
  if (options.scannerProperty.length > 0) conflicts.push('--scanner-property');
  if (options.sonarTokenVarName !== 'SONAR_TOKEN') conflicts.push('--sonar-token-var-name');

  if (conflicts.length > 0) {
    throw new InvalidOptionError(
      `--job-template cannot be combined with ${conflicts.join(', ')}: the job template fully defines the job's shape.`,
    );
  }
}

export function validateOnboardCiGitlabOptions(
  input: OnboardCiGitlabInput,
): OnboardCiGitlabOptions {
  const options = {
    ...input,
    sonarTokenVarName: input.sonarTokenVarName ?? 'SONAR_TOKEN',
    triggerOn: input.triggerOn ?? TriggerOn.Both,
    scannerProperty: input.scannerProperty ?? [],
  };

  if (options.jobTemplate !== undefined) {
    assertNoJobShapeFlagsWithTemplate(options);
  }

  if (!Object.values(TriggerOn).includes(options.triggerOn)) {
    throw new CommandFailedError(
      `Invalid --trigger-on value '${options.triggerOn}'. Must be one of: ${(Object.values(TriggerOn) as string[]).join(', ')}`,
      { exitCode: 2 },
    );
  }

  if (!GITLAB_VAR_NAME_RE.test(options.sonarTokenVarName)) {
    throw new CommandFailedError(
      `Invalid --sonar-token-var-name '${options.sonarTokenVarName}'. ` +
        'Must contain only letters, digits, and underscores and must not start with a digit.',
      { exitCode: 2 },
    );
  }

  if (!GROUP_PATH_RE.test(options.group)) {
    throw new CommandFailedError(
      `Invalid --group value '${options.group}'. Must be a non-empty path without leading or trailing slashes.`,
      { exitCode: 2 },
    );
  }

  if (options.stage !== undefined && !GITLAB_STAGE_NAME_RE.test(options.stage)) {
    throw new CommandFailedError(
      `Invalid --stage value '${options.stage}'. Must be a non-empty name containing only letters, digits, spaces, '.', '_', or '-'.`,
      { exitCode: 2 },
    );
  }

  for (const prop of options.scannerProperty) {
    const eqIdx = prop.indexOf('=');
    if (eqIdx <= 0) {
      throw new CommandFailedError(
        `Invalid --scanner-property '${prop}'. Expected format: key=value (e.g. sonar.scanner.engineJarPath=/path/to/jar).`,
        { exitCode: 2 },
      );
    }
    const key = prop.slice(0, eqIdx);
    const value = prop.slice(eqIdx + 1);
    if (!SCANNER_PROPERTY_KEY_RE.test(key)) {
      throw new CommandFailedError(
        `Invalid --scanner-property key '${key}'. Keys must start with a letter and contain only letters, digits, dots, underscores, or hyphens.`,
        { exitCode: 2 },
      );
    }
    if (value.trim().length === 0 || SCANNER_PROPERTY_VALUE_UNSAFE_RE.test(value)) {
      throw new CommandFailedError(
        `Invalid --scanner-property value for '${key}'. Values must be non-empty and must not contain newlines, ': ', or ' #'.`,
        { exitCode: 2 },
      );
    }
  }
  return options;
}

function applyReposFileFilter<T extends GitLabRepo>(
  allRepos: GitLabRepo[],
  repos: T[],
  reposFile: string,
  group: string,
  console: Console,
): T[] {
  const entries = readReposFile(reposFile);

  const groupPrefix = `${group}/`;
  const relativePath = (r: GitLabRepo) =>
    r.path_with_namespace.startsWith(groupPrefix)
      ? r.path_with_namespace.slice(groupPrefix.length)
      : r.path_with_namespace;

  for (const e of entries) {
    if (repos.some((r) => relativePath(r) === e)) continue;
    if (allRepos.some((r) => relativePath(r) === e)) {
      console.warn(
        `→ '${e}' from --repos-file is not eligible (empty repository or pending deletion), skipped`,
      );
    } else {
      console.warn(`→ '${e}' from --repos-file not found in group, skipped`);
    }
  }

  return repos.filter((r) => entries.has(relativePath(r)));
}

function readJobTemplateFile(jobTemplate: string): string {
  return normalizeJobTemplate(readOptionFile(jobTemplate, '--job-template'));
}

async function preflight(
  connection: SonarConnection,
  gitlabToken: string,
  options: OnboardCiGitlabOptions,
  console: Console,
): Promise<{
  sqsClient: OnboardCiSqsClient;
  gitlabClient: GitLabClient;
  dopSettingId: string;
  dopSettingKey: string;
  gitlabUrl: string;
}> {
  const { auth, httpClient } = connection;
  if (/[\r\n]/.test(auth.serverUrl)) {
    throw new CommandFailedError('The configured SonarQube server URL must be a single line.', {
      exitCode: 2,
      remediationHint: "Re-authenticate with 'sonar auth login' or fix SONARQUBE_CLI_SERVER.",
    });
  }

  assertOnPremiseConnection(auth, 'GitLab');

  const sqsClient = new OnboardCiSqsClient(httpClient);
  const {
    id: dopSettingId,
    key: dopSettingKey,
    url: gitlabUrl,
  } = await resolveDopSetting(sqsClient.bindings, 'gitlab', options.bindingName);
  const gitlabClient = new GitLabClient(gitlabUrl, gitlabToken, {
    onRetry: (message) => {
      console.warn(message);
    },
  });

  return { sqsClient, gitlabClient, dopSettingId, dopSettingKey, gitlabUrl };
}

async function fetchGroupData(
  sqsClient: OnboardCiSqsClient,
  gitlabClient: GitLabClient,
  dopSettingId: string,
  options: OnboardCiGitlabOptions,
  console: Console,
): Promise<{ repos: RepoWithBranch[]; bindingMap: Map<string, Set<string>> }> {
  const bindingMap = await console.withSpinner('Fetching SonarQube project bindings...', () =>
    sqsClient.bindings.getAllProjectBindings(dopSettingId).orThrow(),
  );
  const allRepos = await console.withSpinner('Fetching GitLab repositories...', () =>
    gitlabClient.listGroupRepos(options.group),
  );

  let repos = allRepos.filter(
    (r): r is RepoWithBranch => r.default_branch != null && r.marked_for_deletion_at == null,
  );

  if (options.reposFile) {
    repos = applyReposFileFilter(allRepos, repos, options.reposFile, options.group, console);
  }

  return { repos, bindingMap };
}

export async function onboardCiGitlab(
  connection: SonarConnection,
  gitlabToken: string,
  options: OnboardCiGitlabOptions,
  console: Console,
  telemetry: OnboardingTelemetry | null = null,
): Promise<void> {
  const jobTemplateContent =
    options.jobTemplate !== undefined ? readJobTemplateFile(options.jobTemplate) : undefined;

  const { sqsClient, gitlabClient, dopSettingId, dopSettingKey, gitlabUrl } = await preflight(
    connection,
    gitlabToken,
    options,
    console,
  );

  console.intro('Onboard CI configuration', 'GitLab');
  if (options.dryRun) console.info('DRY RUN: no changes will be made \n');

  console.info(`Using GitLab configuration '${dopSettingKey}' (${gitlabUrl})`);
  console.info(`Processing group: ${options.group}`);

  const { repos, bindingMap } = await fetchGroupData(
    sqsClient,
    gitlabClient,
    dopSettingId,
    options,
    console,
  );

  console.info(`Found ${repos.length.toLocaleString()} repositories to process`);

  const ctx: ProcessRepoContext = {
    gitlab: gitlabClient,
    sqs: sqsClient,
    dopSettingId,
    auth: connection.auth,
    options,
    jobTemplateContent,
  };

  const processRepo = options.dryRun ? assessRepo : executeRepo;
  const results = await runRepos(
    repos,
    (repo) => repo.path_with_namespace,
    (repo, progress) => {
      const gitlab = ctx.gitlab.withRetryHandler((message) => {
        progress.warn(`${repo.path_with_namespace}: ${message}`);
      });
      return processRepo({ ...ctx, gitlab }, repo, bindingMap);
    },
    'MR',
    console,
    telemetry,
  );

  if (options.dryRun) {
    const dryRunResults = {
      wouldOpenMr: results.wouldOpen,
      wouldSkip: results.skipped.map(({ repo, reason }) => ({ repo, reason })),
      failed: results.failed,
    };
    finishOnboarding(results, dryRunResults, 'MR', console, true);
    return;
  }

  const { opened, skipped, failed } = results;
  // Preserve GitLab's published report keys while sharing prUrl internally.
  const report = {
    opened: opened.map(({ prUrl, ...entry }) => ({ ...entry, mrUrl: prUrl })),
    skipped: skipped.map(({ prUrl, ...entry }) => ({ ...entry, mrUrl: prUrl })),
    failed,
  };
  finishOnboarding(results, report, 'MR', console);
}

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

import { readFileSync } from 'node:fs';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import { runWithConcurrencyLimit } from '@/core/concurrency/concurrency-pool.ts';
import type { GitLabRepo } from '@/core/gitlab/client.ts';
import { GitLabClient } from '@/core/gitlab/client.ts';
import { SonarQubeClient } from '@/core/server/client.ts';
import { info, intro, outro, warn, withSpinner } from '@/core/ui';
import { ConcurrentProgress } from '@/core/ui/components/concurrent-progress.ts';

import type { ClassificationEntry } from './dry-run.ts';
import { computeDryRunResults } from './dry-run.ts';
import type { ProcessRepoContext, RepoClassification, RepoWithBranch } from './processor.ts';
import { classifyRepo, executeRepo } from './processor.ts';
import { writeReportFile } from './report.ts';
import type { DryRunResults, OnboardCiGitlabOptions, OnboardCiResults } from './types.ts';
import { TriggerOn } from './types.ts';

export type { OnboardCiGitlabOptions } from './types.ts';

const SETUP_CI_CONCURRENCY_LIMIT = 10;
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

/** Commander collector for repeatable --scanner-property options. */
export function collectScannerProperty(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function validateOnboardCiGitlabOptions(options: OnboardCiGitlabOptions): void {
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
}

async function resolveDopSetting(
  sqs: SonarQubeClient,
  bindingName?: string,
): Promise<{ dopSettingId: string; dopSettingKey: string; gitlabUrl: string }> {
  const settings = await sqs.listGitlabDopSettings();

  if (settings.length === 0) {
    throw new CommandFailedError(
      'No GitLab configuration found in SonarQube.\n' +
        '  → Configure one at Administration > DevOps Platform Integrations > GitLab.',
    );
  }

  if (bindingName) {
    const setting = settings.find((s) => s.key === bindingName);
    if (!setting) {
      const available = settings.map((s) => `  ${s.key}  (${s.url})`).join('\n');
      throw new CommandFailedError(
        `GitLab configuration '${bindingName}' not found. Available configurations:\n${available}`,
        { exitCode: 2 },
      );
    }
    return { dopSettingId: setting.id, dopSettingKey: setting.key, gitlabUrl: setting.url };
  }

  if (settings.length === 1) {
    return {
      dopSettingId: settings[0].id,
      dopSettingKey: settings[0].key,
      gitlabUrl: settings[0].url,
    };
  }

  const list = settings.map((s) => `  ${s.key}  (${s.url})`).join('\n');
  throw new CommandFailedError(
    `Multiple GitLab configurations found. Specify one with --binding-name:\n${list}`,
    { exitCode: 2 },
  );
}

function applyReposFileFilter<T extends GitLabRepo>(
  allRepos: GitLabRepo[],
  repos: T[],
  reposFile: string,
  group: string,
): T[] {
  let fileContent: string;
  try {
    fileContent = readFileSync(reposFile, 'utf8');
  } catch {
    throw new CommandFailedError(`--repos-file: file not found or unreadable: ${reposFile}`, {
      exitCode: 2,
    });
  }
  const entries = new Set(
    fileContent
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );

  const groupPrefix = `${group}/`;
  const relativePath = (r: GitLabRepo) =>
    r.path_with_namespace.startsWith(groupPrefix)
      ? r.path_with_namespace.slice(groupPrefix.length)
      : r.path_with_namespace;

  for (const e of entries) {
    if (repos.some((r) => relativePath(r) === e)) continue;
    if (allRepos.some((r) => relativePath(r) === e)) {
      warn(
        `→ '${e}' from --repos-file is not eligible (empty repository or pending deletion) — skipped`,
      );
    } else {
      warn(`→ '${e}' from --repos-file not found in group — skipped`);
    }
  }

  return repos.filter((r) => entries.has(relativePath(r)));
}

async function preflight(
  auth: ResolvedAuth,
  gitlabToken: string,
  options: OnboardCiGitlabOptions,
): Promise<{
  sqsClient: SonarQubeClient;
  gitlabClient: GitLabClient;
  dopSettingId: string;
  dopSettingKey: string;
  gitlabUrl: string;
}> {
  if (auth.connectionType !== 'on-premise') {
    throw new CommandFailedError(
      'sonar admin onboard-ci gitlab requires a SonarQube Server connection.',
      {
        remediationHint: "Authenticate against SonarQube Server with 'sonar auth login' and retry.",
      },
    );
  }

  const sqsClient = new SonarQubeClient(auth.serverUrl, auth.token);
  if (!(await sqsClient.hasProvisionProjectsPermission())) {
    throw new CommandFailedError(
      'This command requires the "Provision Projects" global permission in SonarQube.',
    );
  }

  const { dopSettingId, dopSettingKey, gitlabUrl } = await resolveDopSetting(
    sqsClient,
    options.bindingName,
  );
  const gitlabClient = new GitLabClient(gitlabUrl, gitlabToken);

  return { sqsClient, gitlabClient, dopSettingId, dopSettingKey, gitlabUrl };
}

async function fetchGroupData(
  sqsClient: SonarQubeClient,
  gitlabClient: GitLabClient,
  dopSettingId: string,
  options: OnboardCiGitlabOptions,
): Promise<{ repos: RepoWithBranch[]; bindingMap: Map<string, string> }> {
  const bindingMap = await withSpinner('Fetching SonarQube project bindings...', () =>
    sqsClient.getAllProjectBindings(dopSettingId),
  );
  const allRepos = await withSpinner('Fetching GitLab repositories...', () =>
    gitlabClient.listGroupRepos(options.group),
  );

  let repos = allRepos.filter(
    (r): r is RepoWithBranch => r.default_branch != null && r.marked_for_deletion_at == null,
  );

  if (options.reposFile) {
    repos = applyReposFileFilter(allRepos, repos, options.reposFile, options.group);
  }

  return { repos, bindingMap };
}

function startRepoProgress(repos: RepoWithBranch[]): ConcurrentProgress {
  const progress = new ConcurrentProgress({
    maxVisible: SETUP_CI_CONCURRENCY_LIMIT,
    showResult: false,
  });
  progress.setTotal(repos.length);
  progress.addItems(repos.map((r) => r.path_with_namespace));
  progress.start();
  return progress;
}

type SkipClassification = Extract<RepoClassification, { outcome: 'skip' }>;
type ProceedClassification = Extract<RepoClassification, { outcome: 'proceed' }>;

async function runConcurrent(
  ctx: ProcessRepoContext,
  repos: RepoWithBranch[],
  bindingMap: Map<string, string>,
  onSkip: (repo: RepoWithBranch, classification: SkipClassification) => void,
  onProceed: (
    repo: RepoWithBranch,
    classification: ProceedClassification,
    slug: string,
    progress: ConcurrentProgress,
  ) => Promise<void>,
  failed: { repo: string; error: string }[],
): Promise<void> {
  const progress = startRepoProgress(repos);
  await runWithConcurrencyLimit(repos, SETUP_CI_CONCURRENCY_LIMIT, async (repo) => {
    const slug = repo.path_with_namespace;
    progress.update(slug, 'running');
    try {
      const classification = await classifyRepo(ctx, repo, bindingMap);
      if (classification.outcome === 'skip') {
        onSkip(repo, classification);
        progress.update(slug, 'done', classification.message);
      } else {
        await onProceed(repo, classification, slug, progress);
      }
    } catch (err) {
      failed.push({ repo: slug, error: String(err) });
      progress.update(slug, 'failed', err instanceof Error ? err.message : String(err));
    }
  });
  progress.finish();
}

async function runDryRun(
  ctx: ProcessRepoContext,
  repos: RepoWithBranch[],
  bindingMap: Map<string, string>,
): Promise<DryRunResults> {
  const classifications: ClassificationEntry[] = [];
  const failedRepos: { repo: string; error: string }[] = [];

  await runConcurrent(
    ctx,
    repos,
    bindingMap,
    (repo, classification) => classifications.push({ repo, classification }),
    (repo, classification, slug, progress) => {
      classifications.push({ repo, classification });
      progress.update(slug, 'done', 'would open MR');
      return Promise.resolve();
    },
    failedRepos,
  );

  return computeDryRunResults(classifications, failedRepos);
}

async function runLive(
  ctx: ProcessRepoContext,
  repos: RepoWithBranch[],
  bindingMap: Map<string, string>,
): Promise<OnboardCiResults> {
  const results: OnboardCiResults = { opened: [], skipped: [], failed: [] };

  await runConcurrent(
    ctx,
    repos,
    bindingMap,
    (repo, classification) =>
      results.skipped.push({
        repo: repo.path_with_namespace,
        reason: classification.reason,
        mrUrl: classification.mrUrl,
      }),
    async (repo, classification, slug, progress) => {
      const result = await executeRepo(ctx, repo, classification);
      results.opened.push({ repo: slug, projectKey: result.projectKey, mrUrl: result.mrUrl });
      progress.update(slug, 'done', 'MR opened');
    },
    results.failed,
  );

  return results;
}

function buildOutroMessage(opened: number, skipped: number, failed: number): string {
  return `Opened ${opened.toLocaleString()} MRs · ${skipped.toLocaleString()} skipped · ${failed.toLocaleString()} failed`;
}

export async function onboardCiGitlab(
  auth: ResolvedAuth,
  gitlabToken: string,
  options: OnboardCiGitlabOptions,
): Promise<void> {
  const { sqsClient, gitlabClient, dopSettingId, dopSettingKey, gitlabUrl } = await preflight(
    auth,
    gitlabToken,
    options,
  );

  intro('Onboard CI configuration', 'GitLab');
  if (options.dryRun) info('DRY RUN — no changes will be made \n');

  info(`Using GitLab configuration '${dopSettingKey}' (${gitlabUrl})`);
  info(`Processing group: ${options.group}`);

  const { repos, bindingMap } = await fetchGroupData(
    sqsClient,
    gitlabClient,
    dopSettingId,
    options,
  );

  info(`Found ${repos.length.toLocaleString()} repositories to process`);

  const ctx: ProcessRepoContext = {
    gitlab: gitlabClient,
    sqs: sqsClient,
    dopSettingId,
    auth,
    options,
  };

  if (options.dryRun) {
    const dryRunResults = await runDryRun(ctx, repos, bindingMap);
    const { wouldOpenMr, wouldSkip, failed } = dryRunResults;
    outro(
      buildOutroMessage(wouldOpenMr.length, wouldSkip.length, failed.length),
      failed.length > 0 ? 'error' : 'success',
      'No changes were made',
    );
    writeReportFile(dryRunResults, 'sonar-onboard-ci-report-dry.json');
    if (failed.length > 0) {
      throw new CommandFailedError(`${failed.length} repositories failed to process.`, {
        remediationHint: 'See the per-repository errors above and the report file for details.',
      });
    }
    return;
  }

  const results = await runLive(ctx, repos, bindingMap);
  const { opened, skipped, failed } = results;
  outro(
    buildOutroMessage(opened.length, skipped.length, failed.length),
    failed.length > 0 ? 'error' : 'success',
  );
  writeReportFile(results, 'sonar-onboard-ci-report.json');
  if (failed.length > 0) {
    throw new CommandFailedError(`${failed.length} repositories failed to process.`, {
      remediationHint: 'See the per-repository errors above and the report file for details.',
    });
  }
}

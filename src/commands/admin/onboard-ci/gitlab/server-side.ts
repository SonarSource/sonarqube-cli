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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import logger from '@/core/observability/logger.ts';
import type {
  CiConfigurationRun,
  CiRunItem,
  CiRunOptions,
  CiTriggerOn,
  CreateCiConfigurationRunRequest,
} from '@/core/server/ci-configuration.ts';
import { CiConfigurationClient, isTerminalCiRunStatus } from '@/core/server/ci-configuration.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { AccessDeniedError, BadRequestError, ForbiddenApiError } from '@/core/server/errors.ts';
import { HTTP_STATUS_FORBIDDEN } from '@/core/server/http-constants.ts';
import { hasNextPage } from '@/core/server/paging.ts';
import type { Console } from '@/core/ui/console.ts';

import { buildOutroMessage, repositoriesFailedError, writeReportFile } from './report.ts';
import { resolveSelectedRepoEntries } from './repos-filter.ts';
import { RunProgress } from './run-progress.ts';
import {
  type DryRunResults,
  type OnboardCiGitlabOptions,
  type OnboardCiResults,
  SkipReason,
  TriggerOn,
} from './types.ts';

const RUN_POLL_INTERVAL_MS = 2000;
const ITEMS_PAGE_SIZE = 100;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
const EXIT_CODE_VALIDATION = 2;
const CANCELLED_ITEM_ERROR = 'cancelled';
const UNKNOWN_ITEM_ERROR = 'unknown error';

const TRIGGER_ON_WIRE: Record<TriggerOn, CiTriggerOn> = {
  [TriggerOn.Mr]: 'MR',
  [TriggerOn.Main]: 'MAIN',
  [TriggerOn.Both]: 'BOTH',
};

export interface ServerSideInputs {
  jobTemplateContent?: string;
  pollIntervalMs?: number;
}

export function provisionProjectsError(): CommandFailedError {
  return new CommandFailedError(
    'This command requires the "Provision Projects" global permission in SonarQube.',
  );
}

/** Turns a 403 from the runs API into the same message the client-side path gives. */
export function translateAccessError(error: unknown): Error {
  const forbidden =
    error instanceof ForbiddenApiError ||
    (error instanceof AccessDeniedError && error.status === HTTP_STATUS_FORBIDDEN);
  if (forbidden) return provisionProjectsError();
  return error instanceof Error ? error : new Error(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function toRunOptions(
  options: OnboardCiGitlabOptions,
  connection: SonarConnection,
  jobTemplateContent: string | undefined,
): CiRunOptions {
  const runOptions: CiRunOptions = { serverUrl: connection.auth.serverUrl };
  if (jobTemplateContent !== undefined) {
    runOptions.jobTemplate = jobTemplateContent;
    return runOptions;
  }
  runOptions.triggerOn = TRIGGER_ON_WIRE[options.triggerOn];
  runOptions.allowFailure = options.allowFailure;
  runOptions.sonarTokenVarName = options.sonarTokenVarName;
  if (options.stage !== undefined) runOptions.stage = options.stage;
  if (options.scannerProperty.length > 0) runOptions.scannerProperties = options.scannerProperty;
  return runOptions;
}

export function buildCreateRunRequest(
  connection: SonarConnection,
  gitlabToken: string,
  options: OnboardCiGitlabOptions,
  jobTemplateContent: string | undefined,
): CreateCiConfigurationRunRequest {
  const selected = resolveSelectedRepoEntries(options);
  if (selected?.entries.size === 0) {
    throw new CommandFailedError(
      `${selected.source}: no repositories listed, refusing to fall back to the whole group.`,
      { exitCode: EXIT_CODE_VALIDATION },
    );
  }
  return {
    provider: 'GITLAB',
    ...(options.bindingName ? { dopSettingKey: options.bindingName } : {}),
    selection: {
      groupPath: options.group,
      ...(selected ? { repoPaths: [...selected.entries] } : {}),
    },
    options: toRunOptions(options, connection, jobTemplateContent),
    dryRun: options.dryRun,
    credential: { type: 'PERSONAL_ACCESS_TOKEN', token: gitlabToken },
  };
}

async function createRun(
  client: CiConfigurationClient,
  request: CreateCiConfigurationRunRequest,
): Promise<string> {
  try {
    return (await client.createRun(request).orThrow()).id;
  } catch (error) {
    if (error instanceof BadRequestError) {
      const message = error.message.replaceAll(request.credential.token, '***');
      throw new CommandFailedError(message, { exitCode: EXIT_CODE_VALIDATION });
    }
    throw translateAccessError(error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollRun(
  client: CiConfigurationClient,
  runId: string,
  progress: RunProgress,
  pollIntervalMs: number,
  previousFailures = 0,
): Promise<CiConfigurationRun> {
  let failures = 0;
  try {
    const run = await client.getRun(runId).orThrow();
    if (isTerminalCiRunStatus(run.status)) return run;
    progress.report(run);
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      throw new CommandFailedError(`CI configuration run ${runId} is no longer available.`, {
        cause: error,
      });
    }
    failures = previousFailures + 1;
    if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) throw translateAccessError(error);
    logger.debug(
      `Polling CI configuration run failed (attempt ${failures}): ${errorMessage(error)}`,
    );
  }
  await sleep(pollIntervalMs);
  return pollRun(client, runId, progress, pollIntervalMs, failures);
}

/** Cancels the run on the first Ctrl-C; a second Ctrl-C then falls back to the default exit. */
async function pollCancellably(
  client: CiConfigurationClient,
  runId: string,
  progress: RunProgress,
  pollIntervalMs: number,
): Promise<CiConfigurationRun> {
  const onSigint = () => {
    process.off('SIGINT', onSigint);
    client
      .cancelRun(runId)
      .orThrow()
      .catch((error: unknown) => {
        logger.debug(`Cancelling CI configuration run failed: ${errorMessage(error)}`);
      });
  };
  process.on('SIGINT', onSigint);
  try {
    return await pollRun(client, runId, progress, pollIntervalMs);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function fetchAllItems(client: CiConfigurationClient, runId: string): Promise<CiRunItem[]> {
  const items: CiRunItem[] = [];
  for (let pageIndex = 1; ; pageIndex++) {
    const page = await client.getRunItems(runId, pageIndex, ITEMS_PAGE_SIZE).orThrow();
    items.push(...page.items);
    const pageSize = page.page.pageSize || ITEMS_PAGE_SIZE;
    if (page.items.length === 0 || !hasNextPage({ ...page.page, pageIndex, pageSize })) {
      return items;
    }
  }
}

function toSkipReason(value: string | null | undefined): SkipReason | undefined {
  return Object.values(SkipReason).find((reason) => reason === value);
}

function toResults(items: CiRunItem[]): OnboardCiResults {
  const results: OnboardCiResults = { opened: [], skipped: [], failed: [] };
  for (const item of items) {
    const repo = item.repository;
    const skipReason = toSkipReason(item.skipReason);
    if (item.status === 'OPENED') {
      results.opened.push({
        repo,
        projectKey: item.projectKey ?? '',
        mrUrl: item.mergeRequestUrl ?? '',
      });
    } else if (item.status === 'SKIPPED' && skipReason) {
      results.skipped.push({
        repo,
        reason: skipReason,
        mrUrl: item.mergeRequestUrl ?? undefined,
      });
    } else {
      results.failed.push({ repo, error: failureMessage(item) });
    }
  }
  return results;
}

function toDryRunResults(items: CiRunItem[]): DryRunResults {
  const results: DryRunResults = { wouldOpenMr: [], wouldSkip: [], failed: [] };
  for (const item of items) {
    const repo = item.repository;
    const skipReason = toSkipReason(item.skipReason);
    if (item.status === 'WOULD_OPEN') {
      results.wouldOpenMr.push({ repo, projectKey: item.projectKey ?? '' });
    } else if (item.status === 'SKIPPED' && skipReason) {
      results.wouldSkip.push({ repo, reason: skipReason });
    } else {
      results.failed.push({ repo, error: failureMessage(item) });
    }
  }
  return results;
}

function failureMessage(item: CiRunItem): string {
  if (item.error) return item.error;
  return item.status === 'SKIPPED' ? CANCELLED_ITEM_ERROR : UNKNOWN_ITEM_ERROR;
}

function finishLive(items: CiRunItem[], console: Console): number {
  const results = toResults(items);
  const { opened, skipped, failed } = results;
  console.outro(
    buildOutroMessage(opened.length, skipped.length, failed.length),
    failed.length > 0 ? 'error' : 'success',
  );
  writeReportFile(results, 'sonar-onboard-ci-report.json', console);
  return failed.length;
}

function finishDryRun(items: CiRunItem[], console: Console): number {
  const results = toDryRunResults(items);
  const { wouldOpenMr, wouldSkip, failed } = results;
  console.outro(
    buildOutroMessage(wouldOpenMr.length, wouldSkip.length, failed.length),
    failed.length > 0 ? 'error' : 'success',
    'No changes were made',
  );
  writeReportFile(results, 'sonar-onboard-ci-report-dry.json', console);
  return failed.length;
}

export async function onboardCiGitlabServerSide(
  connection: SonarConnection,
  gitlabToken: string,
  options: OnboardCiGitlabOptions,
  console: Console,
  inputs: ServerSideInputs = {},
): Promise<void> {
  const request = buildCreateRunRequest(
    connection,
    gitlabToken,
    options,
    inputs.jobTemplateContent,
  );
  const client = new CiConfigurationClient(connection.httpClient);

  console.intro('Onboard CI configuration', 'GitLab');
  if (options.dryRun) console.info('DRY RUN: no changes will be made \n');
  console.info(`Processing group: ${options.group}`);

  const runId = await createRun(client, request);

  const progress = new RunProgress(console);
  progress.begin();
  const run = await pollCancellably(
    client,
    runId,
    progress,
    inputs.pollIntervalMs ?? RUN_POLL_INTERVAL_MS,
  );
  progress.complete(run);

  if (run.status === 'FAILED') {
    throw new CommandFailedError(
      `CI configuration run failed: ${run.error ?? 'no details were provided by the server'}`,
    );
  }

  const items = await fetchAllItems(client, runId);
  const failed = options.dryRun ? finishDryRun(items, console) : finishLive(items, console);

  if (run.status === 'CANCELLED') {
    throw new CommandFailedError('The CI configuration run was cancelled before it completed.');
  }
  if (failed > 0) throw repositoriesFailedError(failed);
}

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
import { ServiceUnavailableError } from '../../../sonarqube/errors.js';
import { blank, confirmPrompt, error, success, text, warn } from '../../../ui';
import { SqaaProgress } from '../../../ui/components/sqaa-progress.js';
import { CommandFailedError, InvalidOptionError } from '../_common/error.js';
import { resolveChangeSet } from './sqaa-changeset';

/** Exit code when analysis succeeds and issues are found. */
const EXIT_CODE_ISSUES_FOUND = 51;

/** Change-set size above which the user is prompted to confirm before proceeding. */
const SQAA_LARGE_CHANGESET_THRESHOLD = 20;

/** Number of files analyzed concurrently within a batch. */
const SQAA_BATCH_SIZE = 3;

/** Maximum number of retries on 503 responses. */
const MAX_503_RETRIES = 3;

/** Base delay for 503 retry backoff in milliseconds. Attempt N waits BASE * 2^(N-1): 2s, 4s, 8s. */
const RETRY_503_BASE_DELAY_MS = 2000;

/** Interval for the live countdown tick in milliseconds. */
const COUNTDOWN_TICK_MS = 1000;

/** Cloud authentication context required for SQAA API calls. */
interface CloudAuth {
  serverUrl: string;
  token: string;
  orgKey: string;
}

export interface AnalyzeSqaaOptions {
  file?: string;
  staged?: boolean;
  base?: string;
  branch?: string;
  project?: string;
  force?: boolean;
}

export async function analyzeSqaa(
  options: AnalyzeSqaaOptions,
  auth: ResolvedAuth,
  command?: Command,
): Promise<void> {
  const { file, staged, base, branch, project, force } = options;

  if (staged && base !== undefined) {
    throw new InvalidOptionError('--staged and --base cannot be used together');
  }

  if (file !== undefined) {
    if (!existsSync(file)) {
      throw new InvalidOptionError(`File not found: ${file}`);
    }
    await runSqaaAnalysis(file, auth, branch, project, command);
    return;
  }

  // Change-set mode: resolve files from Git.
  const files = await resolveChangeSet(process.cwd(), { staged, base });

  if (files.length === 0) {
    blank();
    text('SonarQube Agentic Analysis: no files in the change set to analyze.');
    return;
  }

  if (!force && files.length > SQAA_LARGE_CHANGESET_THRESHOLD) {
    const confirmed = await confirmLargeChangeset(files.length);
    if (!confirmed) return;
  }

  await runSqaaAnalysisOnFiles(files, auth, branch, project, command);
}

async function runSqaaAnalysis(
  file: string,
  auth: ResolvedAuth,
  branch?: string,
  explicitProject?: string,
  command?: Command,
): Promise<void> {
  const resolved = resolveCloudAuthAndProject(auth, explicitProject, command);
  if (!resolved) return;

  const { cloudAuth, projectKey } = resolved;
  const fileContent = readSqaaFileContent(file);
  const issueCount = await callSqaaApiAndDisplay(cloudAuth, projectKey, file, fileContent, branch);
  if (issueCount > 0) {
    process.exitCode = EXIT_CODE_ISSUES_FOUND;
  }
}

const LARGE_CHANGESET_HINT =
  'For faster feedback, try targeting your changes:\n' +
  '  --staged          analyze only staged files\n' +
  '  --base <ref>      analyze files changed vs a branch (e.g. --base main)\n' +
  '  --file <path>     analyze a single specific file';

/**
 * Warn about a large change set and ask the user to confirm.
 * In non-TTY (agent/CI) mode, prints a warning and auto-proceeds.
 * Returns false only when the user explicitly declines in an interactive terminal.
 */
async function confirmLargeChangeset(fileCount: number): Promise<boolean> {
  blank();
  warn(
    `You are about to analyze a large number of files (${fileCount}). This may take longer to process.\n${LARGE_CHANGESET_HINT}`,
  );

  if (!process.stdout.isTTY) {
    return true;
  }

  blank();
  const confirmed = await confirmPrompt('Do you wish to proceed?');
  if (!confirmed) {
    blank();
    text('Analysis cancelled. Use --force to skip this prompt.');
    return false;
  }
  return true;
}

type FileSuccess = {
  file: string;
  filePath: string;
  issues: SqaaIssue[];
  errors?: Array<{ code: string; message: string }> | null;
};
type FileFailure = { file: string; filePath: string; failure: Error };
type FileResult = FileSuccess | FileFailure;

interface BatchContext {
  files: string[];
  allPaths: string[];
  cloudAuth: CloudAuth;
  projectKey: string;
  branch: string | undefined;
  progress: SqaaProgress;
}

interface BatchTally {
  allResults: FileResult[];
  totalIssues: number;
  totalErrors: number;
  totalFailures: number;
}

async function runSqaaAnalysisOnFiles(
  files: string[],
  auth: ResolvedAuth,
  branch?: string,
  explicitProject?: string,
  command?: Command,
): Promise<void> {
  const resolved = resolveCloudAuthAndProject(auth, explicitProject, command);
  if (!resolved) return;

  const { cloudAuth, projectKey } = resolved;
  const allPaths = files.map(toRelativePosixPath);
  const progress = new SqaaProgress({ files: allPaths });
  const ctx: BatchContext = { files, allPaths, cloudAuth, projectKey, branch, progress };
  const tally = await runBatches(ctx);

  progress.finish(tally.allResults.length);
  printFileDetails(tally.allResults);
  printSummary(tally.totalIssues, tally.totalErrors, tally.totalFailures);
}

async function runBatches(ctx: BatchContext): Promise<BatchTally> {
  const batches = chunkArray(ctx.files, SQAA_BATCH_SIZE);
  const tally: BatchTally = { allResults: [], totalIssues: 0, totalErrors: 0, totalFailures: 0 };

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchOffset = batchIdx * SQAA_BATCH_SIZE;
    const batchPaths = ctx.allPaths.slice(batchOffset, batchOffset + batch.length);

    ctx.progress.startBatch(batchOffset, batch.length);
    const batchResponses = await executeBatch(batch, batchOffset, ctx);
    ctx.progress.commitBatch(batchOffset, batch.length);

    const { results, hadFailure } = collectBatchResults(batch, batchPaths, batchResponses);
    tally.allResults.push(...results);
    tallyResults(results, tally);

    if (hadFailure) {
      ctx.progress.skipRemaining(batchOffset + batch.length);
      break;
    }
  }

  return tally;
}

async function executeBatch(
  batch: string[],
  batchOffset: number,
  ctx: BatchContext,
): Promise<
  PromiseSettledResult<{
    issues: SqaaIssue[];
    errors?: Array<{ code: string; message: string }> | null;
  }>[]
> {
  const responses = await Promise.allSettled(
    batch.map(async (file, i) => {
      const globalIdx = batchOffset + i;
      ctx.progress.update(globalIdx, 'analyzing');
      const fileContent = readSqaaFileContent(file);
      const response = await fetchWithRetry(
        ctx.cloudAuth,
        ctx.projectKey,
        file,
        fileContent,
        ctx.branch,
        async (attempt) => {
          await ctx.progress.retrying(
            globalIdx,
            attempt,
            MAX_503_RETRIES,
            RETRY_503_BASE_DELAY_MS * 2 ** (attempt - 1),
          );
          // retrying() already resets status to 'analyzing' when the countdown ends.
        },
      );
      ctx.progress.update(globalIdx, 'done');
      return response;
    }),
  );

  for (let i = 0; i < responses.length; i++) {
    if (responses[i].status === 'rejected') {
      ctx.progress.update(batchOffset + i, 'failed');
    }
  }

  return responses;
}

function tallyResults(results: FileResult[], tally: BatchTally): void {
  for (const r of results) {
    if ('failure' in r) {
      tally.totalFailures += 1;
    } else {
      tally.totalIssues += r.issues.length;
      tally.totalErrors += r.errors?.length ?? 0;
    }
  }
}

function collectBatchResults(
  batch: string[],
  batchPaths: string[],
  batchResponses: PromiseSettledResult<{
    issues: SqaaIssue[];
    errors?: Array<{ code: string; message: string }> | null;
  }>[],
): { results: FileResult[]; hadFailure: boolean } {
  const results: FileResult[] = [];
  let hadFailure = false;

  for (let i = 0; i < batchResponses.length; i++) {
    const resp = batchResponses[i];
    const file = batch[i];
    const filePath = batchPaths[i];
    if (resp.status === 'fulfilled') {
      results.push({ file, filePath, issues: resp.value.issues, errors: resp.value.errors });
    } else {
      results.push({ file, filePath, failure: resp.reason as Error });
      hadFailure = true;
    }
  }

  return { results, hadFailure };
}

function printFileDetails(allResults: FileResult[]): void {
  blank();
  for (const result of allResults) {
    if ('failure' in result) {
      text(`── ${result.filePath}`);
      text(`   Failed to analyze: ${result.failure.message}`);
      blank();
    } else if (result.issues.length > 0 || (result.errors && result.errors.length > 0)) {
      text(`── ${result.filePath}`);
      printIssuesAndErrors(result.issues, result.errors);
    }
  }
}

function printIssuesAndErrors(
  issues: SqaaIssue[],
  errors?: Array<{ code: string; message: string }> | null,
): void {
  if (issues.length > 0) {
    text(`   Found ${issues.length} issue${issues.length === 1 ? '' : 's'}:`);
    blank();
    issues.forEach((issue, idx) => {
      const location = issue.textRange ? ` (line ${issue.textRange.startLine})` : '';
      text(`  [${idx + 1}] ${issue.message}${location}`);
      text(`      Rule: ${issue.rule}`);
    });
    blank();
  }
  if (errors && errors.length > 0) {
    text('   Analysis errors:');
    errors.forEach((e) => {
      text(`  [${e.code}] ${e.message}`);
    });
    blank();
  }
}

function printSummary(totalIssues: number, totalErrors: number, totalFailures: number): void {
  if (totalFailures > 0) {
    // Failures take precedence: the run was incomplete regardless of issues found so far.
    error(
      `SonarQube Agentic Analysis completed with ${totalFailures} failure${totalFailures === 1 ? '' : 's'}.`,
    );
    process.exitCode = 1;
  } else if (totalIssues > 0) {
    process.exitCode = EXIT_CODE_ISSUES_FOUND;
  } else if (totalErrors === 0) {
    success('SonarQube Agentic Analysis completed — change set is clean.');
  }
  // else: no issues, no failures, but API-level errors were printed per file — stay silent on the
  // summary line (matches single-file behavior) and leave the exit code untouched.
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split an array into chunks of at most `size` elements. */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Combines cloud-auth validation and project-key resolution.
 * Returns null (with a warning already printed) when SQAA should be skipped.
 */
function resolveCloudAuthAndProject(
  auth: ResolvedAuth,
  explicitProject: string | undefined,
  command: Command | undefined,
): { cloudAuth: CloudAuth; projectKey: string } | null {
  const cloudAuth = resolveCloudAuth(auth, explicitProject);
  if (!cloudAuth) return null;

  const projectKey = explicitProject ?? resolveSqaaProjectKey(command);
  if (!projectKey) {
    warn(
      'SonarQube Agentic Analysis skipped: no project configured. Specify one with --project or run: sonar integrate claude',
    );
    return null;
  }

  return { cloudAuth, projectKey };
}

/**
 * Validate that the resolved auth is for SonarQube Cloud.
 * Returns null when the connection is not Cloud and --project is not set.
 * Throws CommandFailedError when --project is set but the connection is not Cloud.
 */
function resolveCloudAuth(
  auth: ResolvedAuth,
  explicitProject: string | undefined,
): CloudAuth | null {
  if (auth.connectionType != 'cloud' || auth.orgKey == null) {
    if (explicitProject) {
      throw new CommandFailedError(
        'SonarQube Agentic Analysis requires a SonarQube Cloud connection. Run: sonar auth login',
      );
    }
    warn(
      'SonarQube Agentic Analysis skipped: a SonarQube Cloud connection is required. Run: sonar auth login (ensure you connect to SonarQube Cloud)',
    );
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
 * Fetch the SQAA API response for a single file. Does not print anything.
 * Throws ServiceUnavailableError on 503 (caller handles retry), CommandFailedError on other failures.
 */
async function fetchSqaaResponse(
  auth: CloudAuth,
  projectKey: string,
  file: string,
  fileContent: string,
  branch: string | undefined,
): Promise<{ issues: SqaaIssue[]; errors?: Array<{ code: string; message: string }> | null }> {
  const filePath = toRelativePosixPath(file);
  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  try {
    return await client.analyzeFile({
      organizationKey: auth.orgKey,
      projectKey,
      ...(branch ? { branchName: branch } : {}),
      filePath,
      fileContent,
    });
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    throw new CommandFailedError(`SonarQube Agentic Analysis failed.\n  ${(err as Error).message}`);
  }
}

/**
 * Call the SQAA API and display the results.
 * Returns the number of issues found.
 * Throws CommandFailedError on API failure.
 */
async function callSqaaApiAndDisplay(
  auth: CloudAuth,
  projectKey: string,
  file: string,
  fileContent: string,
  branch: string | undefined,
): Promise<number> {
  blank();
  text('Running SonarQube Agentic Analysis...');
  const response = await fetchWithRetry(auth, projectKey, file, fileContent, branch);
  return displaySqaaResults(response.issues, response.errors);
}

/**
 * Calls fetchSqaaResponse with a 503-retry loop.
 */
async function fetchWithRetry(
  auth: CloudAuth,
  projectKey: string,
  file: string,
  fileContent: string,
  branch: string | undefined,
  onRetry?: (attempt: number) => Promise<void>,
): Promise<{ issues: SqaaIssue[]; errors?: Array<{ code: string; message: string }> | null }> {
  for (let attempt = 1; attempt <= MAX_503_RETRIES + 1; attempt++) {
    try {
      return await fetchSqaaResponse(auth, projectKey, file, fileContent, branch);
    } catch (err) {
      const shouldRetry = err instanceof ServiceUnavailableError && attempt <= MAX_503_RETRIES;
      if (!shouldRetry) throw err;
      await waitBeforeRetry(attempt, onRetry);
    }
  }
  throw new CommandFailedError('SonarQube Agentic Analysis failed: unexpected retry exhaustion.');
}

async function waitBeforeRetry(
  attempt: number,
  onRetry?: (attempt: number) => Promise<void>,
): Promise<void> {
  const delayMs = RETRY_503_BASE_DELAY_MS * 2 ** (attempt - 1);
  if (onRetry) {
    await onRetry(attempt);
  } else {
    await defaultRetryCountdown(attempt, MAX_503_RETRIES, delayMs);
  }
}

/**
 * Countdown used for the single-file path (no SqaaProgress block on screen). Writes to stdout directly.
 */
async function defaultRetryCountdown(
  attempt: number,
  maxRetries: number,
  delayMs: number,
): Promise<void> {
  const totalSeconds = Math.round(delayMs / 1000);
  if (!process.stdout.isTTY) {
    process.stdout.write(
      `⚠️  Server busy (503). Retrying in ${totalSeconds}s... [Attempt ${attempt}/${maxRetries}]\n`,
    );
    await sleep(delayMs);
    return;
  }
  for (let remaining = totalSeconds; remaining > 0; remaining--) {
    process.stdout.write(
      `\r⚠️  Server busy (503). Retrying in ${remaining}s... [Attempt ${attempt}/${maxRetries}]  `,
    );
    await sleep(COUNTDOWN_TICK_MS);
  }
  process.stdout.write('\r\x1b[K');
}

function displaySqaaResults(
  issues: SqaaIssue[],
  errors?: Array<{ code: string; message: string }> | null,
  inChangeSetMode = false,
): number {
  blank();

  if (issues.length === 0) {
    if (!inChangeSetMode) {
      success('SonarQube Agentic Analysis completed — no issues found.');
    }
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

  return issues.length;
}

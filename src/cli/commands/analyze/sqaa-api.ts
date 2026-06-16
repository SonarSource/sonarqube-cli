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

// HTTP API layer for SQAA: fetch, retry, and single-file display.

import { readFileSync } from 'node:fs';

import { getSqaaRetry503BaseDelayMs } from '../../../lib/config-constants';
import { toRelativePosixPath as toRelativePosixPathOrNull } from '../../../lib/fs-utils';
import type { SqaaAnalysisFile, SqaaIssue } from '../../../sonarqube/client';
import { SonarQubeClient } from '../../../sonarqube/client';
import { RequestPayloadTooLargeError, ServiceUnavailableError } from '../../../sonarqube/errors.js';
import { CommandFailedError, InvalidOptionError } from '../_common/error.js';
import type { CloudAuth } from './sqaa-auth';
import { type PackChunksLimits, packFilesIntoChunks, type SqaaChunkFile } from './sqaa-chunking';
import { displaySqaaResults, printSingleFileTextFailure } from './sqaa-display';
import {
  payloadTooLargeCommandError,
  sqaaCommandFailedError,
  toSqaaCommandError,
} from './sqaa-errors.js';
import { partitionSqaaAnalysisFiles, type SqaaFileValidationRejection } from './sqaa-validation.js';

/** Maximum number of retries on 503 responses. */
export const MAX_503_RETRIES = 3;

/** Interval for the live countdown tick in milliseconds. */
const COUNTDOWN_TICK_MS = 1000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read file content for SQAA analysis.
 * Throws CommandFailedError when the file cannot be read.
 */
export function readSqaaFileContent(file: string): string {
  try {
    return readFileSync(file, 'utf-8');
  } catch (err) {
    throw new CommandFailedError(`Failed to read file: ${(err as Error).message}`, {
      remediationHint: `Check that '${file}' exists and is readable as a file, then retry.`,
    });
  }
}

/**
 * Throwing wrapper over `lib/fs-utils.toRelativePosixPath`.
 * Throws when `file` is outside `base` (traversal) or on a different drive.
 */
export function toRelativePosixPath(file: string, base: string = process.cwd()): string {
  const rel = toRelativePosixPathOrNull(file, base);
  if (rel == null) {
    throw new InvalidOptionError(`File must be inside ${base}: ${file}`);
  }
  return rel;
}

function isRetryableSqaaError(err: unknown, includePayloadTooLarge: boolean): boolean {
  if (err instanceof ServiceUnavailableError) {
    return true;
  }
  return includePayloadTooLarge && err instanceof RequestPayloadTooLargeError;
}

export type SqaaPostResult = {
  response: SqaaChunkResponse;
  rejected: SqaaFileValidationRejection[];
};

function validChunkFilesAfterRejection(
  chunkFiles: SqaaChunkFile[],
  rejected: SqaaFileValidationRejection[],
): SqaaChunkFile[] {
  const rejectedIndices = new Set<number>(rejected.map((entry) => entry.index));
  return chunkFiles.filter((_, index) => !rejectedIndices.has(index));
}

function validationGroupErrors(
  rejected: SqaaFileValidationRejection[],
  chunkFiles: SqaaChunkFile[],
): SqaaChunkGroupError[] {
  return rejected.map(({ index, error }) => ({
    files: chunkFiles[index] ? [chunkFiles[index]] : [],
    error,
  }));
}

async function postSqaaAnalysis(
  auth: CloudAuth,
  projectKey: string,
  branch: string | undefined,
  files: SqaaAnalysisFile[],
  options: { analysisDepth?: 'DEEP'; includePayloadTooLarge?: boolean } = {},
): Promise<SqaaPostResult> {
  const { valid, rejected } = partitionSqaaAnalysisFiles(files, {
    analysisDepth: options.analysisDepth,
  });

  if (valid.length === 0) {
    throw (
      rejected[0]?.error ?? sqaaCommandFailedError('files[] must contain at least one valid file.')
    );
  }

  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  try {
    const response = await client.createAnalysis({
      organizationKey: auth.orgKey,
      projectKey,
      ...(branch ? { branchName: branch } : {}),
      ...(options.analysisDepth ? { analysisDepth: options.analysisDepth } : {}),
      files: valid,
    });
    return { response, rejected };
  } catch (err) {
    if (isRetryableSqaaError(err, options.includePayloadTooLarge ?? false)) {
      throw err;
    }
    throw toSqaaCommandError(err);
  }
}

/** Validated SQAA POST for hook and other callers outside the analyze command. */
export async function submitValidatedSqaaAnalysis(
  auth: CloudAuth,
  projectKey: string,
  files: SqaaAnalysisFile[],
  options: { branch?: string; analysisDepth?: 'DEEP' } = {},
): Promise<SqaaChunkResponse> {
  const { response } = await postSqaaAnalysis(auth, projectKey, options.branch, files, {
    analysisDepth: options.analysisDepth,
  });
  return response;
}

/**
 * Fetch the SQAA API response for a single file. Does not print anything.
 * Throws ServiceUnavailableError on 503 (caller handles retry), CommandFailedError on other failures.
 *
 * `pathBase` is the directory the SQAA-side file path is computed relative to.
 * Defaults to `process.cwd()` for the single-file path; change-set callers
 * pass the repository root so paths are stable regardless of where the user runs.
 */
export async function fetchSqaaResponse(
  auth: CloudAuth,
  projectKey: string,
  file: string,
  fileContent: string,
  branch: string | undefined,
  pathBase?: string,
): Promise<{ issues: SqaaIssue[]; errors?: Array<{ code: string; message: string }> | null }> {
  const filePath = toRelativePosixPath(file, pathBase);
  const { response, rejected } = await postSqaaAnalysis(auth, projectKey, branch, [
    { path: filePath, content: fileContent },
  ]);
  if (rejected.length > 0) {
    throw rejected[0].error;
  }
  return response;
}

async function with503Retry<T>(
  fetch: () => Promise<T>,
  onRetry?: (attempt: number) => Promise<void>,
): Promise<T> {
  let lastServiceError: ServiceUnavailableError | undefined;
  for (let attempt = 1; attempt <= MAX_503_RETRIES + 1; attempt++) {
    try {
      return await fetch();
    } catch (err) {
      if (!(err instanceof ServiceUnavailableError)) {
        throw err;
      }
      lastServiceError = err;
      if (attempt <= MAX_503_RETRIES) {
        await waitBeforeRetry(attempt, onRetry);
      }
    }
  }
  throw new CommandFailedError(
    `SonarQube Agentic Analysis failed after ${MAX_503_RETRIES} retries. The service is still unavailable.`,
    { cause: lastServiceError },
  );
}

/**
 * Calls fetchSqaaResponse with a 503-retry loop.
 */
export async function fetchWithRetry(
  auth: CloudAuth,
  projectKey: string,
  file: string,
  fileContent: string,
  branch: string | undefined,
  onRetry?: (attempt: number) => Promise<void>,
  pathBase?: string,
): Promise<{ issues: SqaaIssue[]; errors?: Array<{ code: string; message: string }> | null }> {
  return with503Retry(
    () => fetchSqaaResponse(auth, projectKey, file, fileContent, branch, pathBase),
    onRetry,
  );
}

export type SqaaChunkResponse = {
  issues: SqaaIssue[];
  errors?: Array<{ code: string; message: string }> | null;
};

export type SqaaChunkPart = {
  response: SqaaChunkResponse;
  files: SqaaChunkFile[];
};

export type SqaaChunkFetchResult = {
  parts: SqaaChunkPart[];
  groupErrors: SqaaChunkGroupError[];
};

export type SqaaChunkGroupError = {
  files: SqaaChunkFile[];
  error: Error;
};

function packLimitsForRequest(
  auth: CloudAuth,
  projectKey: string,
  branch: string | undefined,
  overrides: { maxRequestBytes?: number; maxFilesPerRequest?: number } = {},
) {
  return {
    ...overrides,
    organizationKey: auth.orgKey,
    projectKey,
    ...(branch ? { branchName: branch } : {}),
  };
}

function packLimitsFrom413Error(
  auth: CloudAuth,
  projectKey: string,
  branch: string | undefined,
  err: RequestPayloadTooLargeError,
) {
  return packLimitsForRequest(auth, projectKey, branch, {
    ...(err.meta?.maxRequestSize == null ? {} : { maxRequestBytes: err.meta.maxRequestSize }),
    ...(err.meta?.maxFiles == null ? {} : { maxFilesPerRequest: err.meta.maxFiles }),
  });
}

/**
 * Fetch the SQAA API response for a multi-file chunk with `analysisDepth: DEEP`.
 * Throws ServiceUnavailableError on 503, RequestPayloadTooLargeError on 413.
 */
export async function fetchChunkResponse(
  auth: CloudAuth,
  projectKey: string,
  files: SqaaAnalysisFile[],
  branch: string | undefined,
): Promise<SqaaPostResult> {
  return postSqaaAnalysis(auth, projectKey, branch, files, {
    analysisDepth: 'DEEP',
    includePayloadTooLarge: true,
  });
}

/**
 * Calls fetchChunkResponse with a 503-retry loop.
 */
export async function fetchChunkWithRetry(
  auth: CloudAuth,
  projectKey: string,
  files: SqaaAnalysisFile[],
  branch: string | undefined,
  onRetry?: (attempt: number) => Promise<void>,
): Promise<SqaaPostResult> {
  return with503Retry(() => fetchChunkResponse(auth, projectKey, files, branch), onRetry);
}

function toAnalysisFiles(chunkFiles: SqaaChunkFile[]): SqaaAnalysisFile[] {
  return chunkFiles.map((f) => ({ path: f.relativePath, content: f.content }));
}

function splitChunkFiles(files: SqaaChunkFile[], limits: PackChunksLimits): SqaaChunkFile[][] {
  const packed = packFilesIntoChunks(files, limits);
  if (packed.length > 1) {
    return packed.map((chunk) => chunk.files);
  }
  const mid = Math.ceil(files.length / 2);
  return [files.slice(0, mid), files.slice(mid)];
}

/** 503 after retry exhaustion is wrapped in CommandFailedError; both must fail-fast. */
function isTransientChunkFetchError(err: unknown): boolean {
  if (err instanceof ServiceUnavailableError) {
    return true;
  }
  return err instanceof CommandFailedError && err.cause instanceof ServiceUnavailableError;
}

async function fetchSplitParts(
  auth: CloudAuth,
  projectKey: string,
  partGroups: SqaaChunkFile[][],
  branch: string | undefined,
  onRetry?: (attempt: number) => Promise<void>,
  onPayloadSplit?: () => void,
): Promise<SqaaChunkFetchResult> {
  const parts: SqaaChunkPart[] = [];
  const groupErrors: SqaaChunkGroupError[] = [];
  for (const group of partGroups) {
    try {
      const result = await fetchChunkWith413Split(
        auth,
        projectKey,
        group,
        branch,
        onRetry,
        onPayloadSplit,
      );
      parts.push(...result.parts);
      groupErrors.push(...result.groupErrors);
    } catch (err) {
      if (isTransientChunkFetchError(err)) {
        throw err;
      }
      groupErrors.push({ files: group, error: err as Error });
    }
  }
  return { parts, groupErrors };
}

/**
 * Send a chunk with 503 retry; on 413 split the chunk and retry sub-chunks sequentially.
 * Returns partial successes when only some sub-chunks fail after splitting.
 */
export async function fetchChunkWith413Split(
  auth: CloudAuth,
  projectKey: string,
  chunkFiles: SqaaChunkFile[],
  branch: string | undefined,
  onRetry?: (attempt: number) => Promise<void>,
  onPayloadSplit?: () => void,
): Promise<SqaaChunkFetchResult> {
  const analysisFiles = toAnalysisFiles(chunkFiles);
  const preflight = partitionSqaaAnalysisFiles(analysisFiles, { analysisDepth: 'DEEP' });
  if (preflight.valid.length === 0) {
    return {
      parts: [],
      groupErrors: validationGroupErrors(preflight.rejected, chunkFiles),
    };
  }

  try {
    const { response, rejected } = await fetchChunkWithRetry(
      auth,
      projectKey,
      analysisFiles,
      branch,
      onRetry,
    );
    const validationErrors = validationGroupErrors(rejected, chunkFiles);
    const validChunkFiles = validChunkFilesAfterRejection(chunkFiles, rejected);

    return {
      parts: [{ response, files: validChunkFiles }],
      groupErrors: validationErrors,
    };
  } catch (err) {
    if (!(err instanceof RequestPayloadTooLargeError)) {
      throw err;
    }

    const { rejected } = preflight;
    const validationErrors = validationGroupErrors(rejected, chunkFiles);
    const validChunkFiles = validChunkFilesAfterRejection(chunkFiles, rejected);

    if (validChunkFiles.length === 1) {
      return {
        parts: [],
        groupErrors: [
          ...validationErrors,
          { files: validChunkFiles, error: payloadTooLargeCommandError(err) },
        ],
      };
    }

    onPayloadSplit?.();

    const splitResult = await fetchSplitParts(
      auth,
      projectKey,
      splitChunkFiles(validChunkFiles, packLimitsFrom413Error(auth, projectKey, branch, err)),
      branch,
      onRetry,
      onPayloadSplit,
    );
    return {
      parts: splitResult.parts,
      groupErrors: [...validationErrors, ...splitResult.groupErrors],
    };
  }
}

export async function waitBeforeRetry(
  attempt: number,
  onRetry?: (attempt: number) => Promise<void>,
): Promise<void> {
  const delayMs = getSqaaRetry503BaseDelayMs() * 2 ** (attempt - 1);
  if (onRetry) {
    await onRetry(attempt);
  } else {
    await defaultRetryCountdown(attempt, MAX_503_RETRIES, delayMs);
  }
}

/**
 * Countdown used for the single-file path (no SqaaProgress block on screen). Writes to stdout directly.
 */
export async function defaultRetryCountdown(
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

/**
 * Call the SQAA API and display the results for the single-file path.
 * Returns the number of issues found. Analysis failures render as a ✗ file row (exit 1).
 */
export async function callSqaaApiAndDisplay(
  auth: CloudAuth,
  projectKey: string,
  file: string,
  fileContent: string,
  branch: string | undefined,
): Promise<number> {
  const filePath = toRelativePosixPath(file);
  try {
    const response = await fetchWithRetry(auth, projectKey, file, fileContent, branch);
    return displaySqaaResults(response.issues, response.errors, filePath);
  } catch (err) {
    printSingleFileTextFailure(filePath, err as Error);
    return 0;
  }
}

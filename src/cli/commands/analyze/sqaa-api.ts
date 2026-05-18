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

import { toRelativePosixPath as toRelativePosixPathOrNull } from '../../../lib/fs-utils';
import type { SqaaIssue } from '../../../sonarqube/client';
import { SonarQubeClient } from '../../../sonarqube/client';
import { ServiceUnavailableError } from '../../../sonarqube/errors.js';
import { blank, text } from '../../../ui';
import { CommandFailedError, InvalidOptionError } from '../_common/error.js';
import type { CloudAuth } from './sqaa-auth';
import { displaySqaaResults } from './sqaa-display';

/** Maximum number of retries on 503 responses. */
export const MAX_503_RETRIES = 3;

/** Base delay for 503 retry backoff in milliseconds. Attempt N waits BASE * 2^(N-1): 2s, 4s, 8s. */
export const RETRY_503_BASE_DELAY_MS = 2000;

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
    throw new CommandFailedError(
      `SonarQube Agentic Analysis failed.\n  ${(err as Error).message}`,
      {
        remediationHint:
          'Check your SonarQube Cloud authentication, project key, and network connectivity, then retry.',
      },
    );
  }
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
  for (let attempt = 1; attempt <= MAX_503_RETRIES + 1; attempt++) {
    try {
      return await fetchSqaaResponse(auth, projectKey, file, fileContent, branch, pathBase);
    } catch (err) {
      const shouldRetry = err instanceof ServiceUnavailableError && attempt <= MAX_503_RETRIES;
      if (!shouldRetry) throw err;
      await waitBeforeRetry(attempt, onRetry);
    }
  }
  throw new CommandFailedError(
    `SonarQube Agentic Analysis failed after ${MAX_503_RETRIES} retries. The service is still unavailable.`,
    {
      remediationHint:
        'Check your SonarQube Cloud authentication, project key, and network connectivity, then retry.',
    },
  );
}

export async function waitBeforeRetry(
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
 * Returns the number of issues found. Throws CommandFailedError on API failure.
 */
export async function callSqaaApiAndDisplay(
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

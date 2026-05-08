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

// Batch execution engine for SQAA change-set analysis.

import type { SqaaIssue } from '../../../sonarqube/client';
import type { SqaaProgress } from '../../../ui/components/sqaa-progress.js';
import {
  fetchWithRetry,
  MAX_503_RETRIES,
  readSqaaFileContent,
  RETRY_503_BASE_DELAY_MS,
} from './sqaa-api';
import type { CloudAuth } from './sqaa-auth';

/** Number of files analyzed concurrently within a batch. */
export const SQAA_BATCH_SIZE = 3;

export type FileSuccess = {
  file: string;
  filePath: string;
  issues: SqaaIssue[];
  errors?: Array<{ code: string; message: string }> | null;
};
export type FileFailure = { file: string; filePath: string; failure: Error };
export type FileResult = FileSuccess | FileFailure;

export interface BatchContext {
  files: string[];
  allPaths: string[];
  cloudAuth: CloudAuth;
  projectKey: string;
  branch: string | undefined;
  progress: SqaaProgress;
}

export interface BatchTally {
  allResults: FileResult[];
  totalIssues: number;
  totalErrors: number;
  totalFailures: number;
}

export async function runBatches(ctx: BatchContext): Promise<BatchTally> {
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

export function tallyResults(results: FileResult[], tally: BatchTally): void {
  for (const r of results) {
    if ('failure' in r) {
      tally.totalFailures += 1;
    } else {
      tally.totalIssues += r.issues.length;
      tally.totalErrors += r.errors?.length ?? 0;
    }
  }
}

export function collectBatchResults(
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

/** Split an array into chunks of at most `size` elements. */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

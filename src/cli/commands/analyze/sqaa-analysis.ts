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

// Concurrent execution engine for SQAA change-set analysis

import { getSqaaRetry503BaseDelayMs } from '../../../lib/config-constants';
import type { SqaaIssue } from '../../../sonarqube/client';
import type { SqaaProgress } from '../../../ui/components/sqaa-progress.js';
import { fetchWithRetry, MAX_503_RETRIES, readSqaaFileContent } from './sqaa-api';
import type { CloudAuth } from './sqaa-auth';

/** Maximum number of files analyzed concurrently. */
export const SQAA_CONCURRENCY = 20;

export type FileSuccess = {
  file: string;
  filePath: string;
  issues: SqaaIssue[];
  errors?: Array<{ code: string; message: string }> | null;
};
export type FileFailure = { file: string; filePath: string; failure: Error };
export type FileResult = FileSuccess | FileFailure;

export interface RunContext {
  files: string[];
  allPaths: string[];
  cloudAuth: CloudAuth;
  projectKey: string;
  branch: string | undefined;
  progress: SqaaProgress;
  /** Directory used as the base for SQAA-side file paths (typically the git repo root). */
  pathBase: string;
}

export interface RunTally {
  allResults: FileResult[];
  totalIssues: number;
  totalErrors: number;
  totalFailures: number;
}

/**
 * Run analyses through a worker pool of `SQAA_CONCURRENCY`. Returns the merged
 * tally once every spawned worker has joined.
 *
 * Fail-fast contract: if any file fails, no worker will pick up a *new* file
 * after that point. Workers already mid-flight finish their current file.
 */
export async function runAnalyses(ctx: RunContext): Promise<RunTally> {
  const tally: RunTally = { allResults: [], totalIssues: 0, totalErrors: 0, totalFailures: 0 };
  if (ctx.files.length === 0) return tally;

  // Shared cursor and fail-fast flag.
  // `next` is the count of indices claimed so far (each worker does `idx = next++`).
  // `hadFailure` is the fail-fast signal: set when any file fails.
  let next = 0;
  let hadFailure = false;

  const worker = async (): Promise<void> => {
    while (!hadFailure) {
      const idx = next++;
      if (idx >= ctx.files.length) return;
      const result = await processFile(ctx, idx);
      tally.allResults.push(result);
      tallyResults([result], tally);
      if ('failure' in result) {
        hadFailure = true;
      }
    }
  };

  const workerCount = Math.min(SQAA_CONCURRENCY, ctx.files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // `next` equals the total number of indices claimed across all workers (including
  // any that went past the end of the array). Cap it to get the first unclaimed index.
  const firstUnpicked = Math.min(next, ctx.files.length);
  if (firstUnpicked < ctx.files.length) {
    ctx.progress.skipRemaining(firstUnpicked);
  }

  // Workers complete in arbitrary order. Restore original file ordering so that
  // downstream consumers (JSON report, text display) see a stable, predictable sequence.
  const fileIndexMap = new Map(ctx.files.map((f, i) => [f, i]));
  tally.allResults.sort(
    (a, b) => (fileIndexMap.get(a.file) ?? 0) - (fileIndexMap.get(b.file) ?? 0),
  );

  return tally;
}

/**
 * Process a single file end-to-end: read content, call the API with 503 retry,
 * and emit progress transitions. Errors (including retry exhaustion) are caught and converted into a `FileFailure`.
 */
async function processFile(ctx: RunContext, idx: number): Promise<FileResult> {
  const file = ctx.files[idx];
  const filePath = ctx.allPaths[idx];
  ctx.progress.update(idx, 'analyzing');
  try {
    const fileContent = readSqaaFileContent(file);
    const response = await fetchWithRetry(
      ctx.cloudAuth,
      ctx.projectKey,
      file,
      fileContent,
      ctx.branch,
      async (attempt) => {
        await ctx.progress.retrying(
          idx,
          attempt,
          MAX_503_RETRIES,
          getSqaaRetry503BaseDelayMs() * 2 ** (attempt - 1),
        );
        // retrying() already resets status to 'analyzing' when the countdown ends.
      },
      ctx.pathBase,
    );
    ctx.progress.update(idx, 'done');
    return { file, filePath, issues: response.issues, errors: response.errors };
  } catch (err) {
    ctx.progress.update(idx, 'failed');
    return { file, filePath, failure: err as Error };
  }
}

export function tallyResults(results: FileResult[], tally: RunTally): void {
  for (const r of results) {
    if ('failure' in r) {
      tally.totalFailures += 1;
    } else {
      tally.totalIssues += r.issues.length;
      tally.totalErrors += r.errors?.length ?? 0;
    }
  }
}

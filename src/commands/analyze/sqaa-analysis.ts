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

// Sequential chunked execution engine for SQAA change-set analysis

import { getSqaaRetry503BaseDelayMs } from '@/core/config-constants.ts';
import type { SonarConnection } from '@/core/server/connection.ts';

import {
  fetchChunkWith413Split,
  MAX_503_RETRIES,
  readSqaaFileContent,
  type SqaaChunkGroupError,
  type SqaaChunkResponse,
} from './sqaa-api.ts';
import { type SqaaChunk, type SqaaChunkFile } from './sqaa-chunking.ts';
import type { SqaaDeepWireDepth } from './sqaa-depth.ts';
import { isGlobalSqaaError, isPayloadTooLargeCommandError } from './sqaa-errors.ts';
import { type SqaaPath, withDisplayFilePath } from './sqaa-paths.ts';
import type { SqaaProgress } from './sqaa-progress.ts';
import type { SqaaAnalysisDepth, SqaaIssue } from './sqaa-wire-types.ts';

export type FileSuccess = {
  file: string;
  filePath: string;
  issues: SqaaIssue[];
  errors?: Array<{ code: string; message: string }> | null;
};
export type FileFailure = { file: string; filePath: string; failure: Error };
export type FileResult = FileSuccess | FileFailure;

export interface RunContext {
  paths: SqaaPath[];
  connection: SonarConnection;
  projectKey: string;
  branch: string | undefined;
  progress: SqaaProgress;
  analysisDepth?: SqaaDeepWireDepth;
  displayAnalysisDepth: SqaaAnalysisDepth;
}

export interface RunTally {
  allResults: FileResult[];
  totalIssues: number;
  /** API `errors[]` warnings on successfully analyzed files (not HTTP failures). */
  totalErrors: number;
  /** Files that could not be analyzed (HTTP 4xx/5xx, fetch errors, etc.). */
  totalFailures: number;
  /**
   * Set when the server refused the run outright, so callers can report a single
   * run-level cause instead of per-file failures they cannot act on.
   */
  globalError?: Error;
}

/**
 * Run analyses as sequential multi-file chunks. Returns the merged tally once
 * every chunk has been processed (or fail-fast stops remaining chunks).
 */
export async function runAnalyses(ctx: RunContext): Promise<RunTally> {
  const tally = emptyTally();
  if (ctx.paths.length === 0) return tally;

  const fileIndexByAbsolutePath = new Map(ctx.paths.map((p, i) => [p.absolutePath, i]));
  const { chunks, chunkFileIndices } = prepareChunks(
    ctx,
    fileIndexByAbsolutePath,
    tally,
    ctx.progress,
  );
  ctx.progress.start();

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const succeeded = await processChunk(
      ctx,
      tally,
      chunkIndex,
      chunks[chunkIndex],
      chunkFileIndices[chunkIndex],
      fileIndexByAbsolutePath,
    );
    if (!succeeded) {
      skipUnprocessedAfterFailure(ctx, tally);
      break;
    }
  }

  sortResultsByFileOrder(tally, ctx.paths);
  return tally;
}

function emptyTally(): RunTally {
  return { allResults: [], totalIssues: 0, totalErrors: 0, totalFailures: 0 };
}

/** Combines per-project tallies into one run tally; results keep the order the tallies were given in. */
export function mergeTallies(tallies: RunTally[]): RunTally {
  const merged = emptyTally();
  for (const tally of tallies) {
    merged.allResults.push(...tally.allResults);
    merged.totalIssues += tally.totalIssues;
    merged.totalErrors += tally.totalErrors;
    merged.totalFailures += tally.totalFailures;
    merged.globalError ??= tally.globalError;
  }
  return merged;
}

function prepareChunks(
  ctx: RunContext,
  fileIndexByAbsolutePath: Map<string, number>,
  tally: RunTally,
  progress: SqaaProgress,
): { chunks: SqaaChunk[]; chunkFileIndices: number[][] } {
  const readableChunkFiles: SqaaChunkFile[] = [];
  for (let idx = 0; idx < ctx.paths.length; idx++) {
    const path = ctx.paths[idx];
    try {
      readableChunkFiles.push({
        absolutePath: path.absolutePath,
        relativePath: path.serverPath,
        content: readSqaaFileContent(path.absolutePath),
      });
    } catch (err) {
      recordFileFailure(progress, tally, idx, path, err as Error);
    }
  }

  if (readableChunkFiles.length === 0) {
    return { chunks: [], chunkFileIndices: [] };
  }

  const chunks: SqaaChunk[] = [{ files: readableChunkFiles }];
  const chunkFileIndices = [
    readableChunkFiles.map((f) => {
      const idx = fileIndexByAbsolutePath.get(f.absolutePath);
      if (idx === undefined) {
        throw new Error(`Missing file index for ${f.absolutePath}`);
      }
      return idx;
    }),
  ];
  return { chunks, chunkFileIndices };
}

function chunkPathsForFiles(
  ctx: RunContext,
  chunkFiles: SqaaChunkFile[],
  fileIndexByAbsolutePath: Map<string, number>,
): { partPaths: SqaaPath[]; partIndices: number[] } {
  const partPaths: SqaaPath[] = [];
  const partIndices: number[] = [];
  for (const chunkFile of chunkFiles) {
    const idx = fileIndexByAbsolutePath.get(chunkFile.absolutePath);
    if (idx === undefined) {
      continue;
    }
    partPaths.push(ctx.paths[idx]);
    partIndices.push(idx);
  }
  return { partPaths, partIndices };
}

function chunkPathsForIndices(ctx: RunContext, fileIndices: number[]): SqaaPath[] {
  return fileIndices.map((idx) => ctx.paths[idx]);
}

function recordSuccessfulParts(
  ctx: RunContext,
  tally: RunTally,
  progress: SqaaProgress,
  parts: Array<{ response: SqaaChunkResponse; files: SqaaChunkFile[] }>,
  fileIndexByAbsolutePath: Map<string, number>,
): void {
  for (const part of parts) {
    if (part.files.length === 0) {
      continue;
    }
    const { partPaths, partIndices } = chunkPathsForFiles(ctx, part.files, fileIndexByAbsolutePath);
    recordChunkSuccess(progress, tally, partIndices, partPaths, part.response);
  }
}

function recordGroupFetchErrors(
  ctx: RunContext,
  tally: RunTally,
  progress: SqaaProgress,
  groupErrors: SqaaChunkGroupError[],
  fileIndexByAbsolutePath: Map<string, number>,
): void {
  for (const { files, error } of groupErrors) {
    for (const failed of files) {
      const idx = fileIndexByAbsolutePath.get(failed.absolutePath);
      if (idx === undefined) {
        continue;
      }
      recordFileFailure(progress, tally, idx, ctx.paths[idx], error);
    }
  }
}

/** Whether to continue remaining chunks after a mixed or successful chunk fetch. */
export function shouldContinueAfterChunk(
  parts: Array<{ response: SqaaChunkResponse; files: SqaaChunkFile[] }>,
  groupErrors: SqaaChunkGroupError[],
): boolean {
  if (groupErrors.length === 0 || parts.length > 0) {
    return true;
  }
  return groupErrors.every((group) => isPayloadTooLargeCommandError(group.error));
}

async function processChunk(
  ctx: RunContext,
  tally: RunTally,
  chunkIndex: number,
  chunk: SqaaChunk,
  fileIndices: number[],
  fileIndexByAbsolutePath: Map<string, number>,
): Promise<boolean> {
  const chunkPaths = chunkPathsForIndices(ctx, fileIndices);
  markChunkAnalyzing(ctx.progress, chunkIndex, fileIndices);

  try {
    const { parts, groupErrors } = await fetchChunkWith413Split(
      ctx.connection,
      ctx.projectKey,
      chunk.files,
      ctx.branch,
      (attempt) =>
        ctx.progress.retryingChunk(
          chunkIndex,
          attempt,
          MAX_503_RETRIES,
          getSqaaRetry503BaseDelayMs() * 2 ** (attempt - 1),
        ),
      () => {
        ctx.progress.warnPayloadSplit();
      },
      ctx.analysisDepth,
    );

    recordSuccessfulParts(ctx, tally, ctx.progress, parts, fileIndexByAbsolutePath);
    recordGroupFetchErrors(ctx, tally, ctx.progress, groupErrors, fileIndexByAbsolutePath);

    ctx.progress.updateChunk(chunkIndex, 'done');
    return shouldContinueAfterChunk(parts, groupErrors);
  } catch (err) {
    if (isGlobalSqaaError(err)) {
      recordGlobalFailure(ctx.progress, tally, chunkIndex, err as Error);
    } else {
      recordChunkFailure(ctx.progress, tally, chunkIndex, fileIndices, chunkPaths, err as Error);
    }
    return false;
  }
}

function markChunkAnalyzing(
  progress: SqaaProgress,
  chunkIndex: number,
  fileIndices: number[],
): void {
  progress.updateChunk(chunkIndex, 'analyzing');
  for (const idx of fileIndices) {
    progress.update(idx, 'analyzing');
  }
}

function recordChunkSuccess(
  progress: SqaaProgress,
  tally: RunTally,
  fileIndices: number[],
  chunkPaths: SqaaPath[],
  response: SqaaChunkResponse,
): void {
  const results = distributeChunkResponse(response.issues, response.errors, chunkPaths);
  tally.allResults.push(...results);
  tallyResults(results, tally);
  for (const idx of fileIndices) {
    progress.update(idx, 'done');
  }
}

function recordFileFailure(
  progress: SqaaProgress,
  tally: RunTally,
  fileIndex: number,
  path: SqaaPath,
  error: Error,
): void {
  progress.update(fileIndex, 'failed');
  const failure: FileFailure = {
    file: path.absolutePath,
    filePath: path.displayPath,
    failure: error,
  };
  tally.allResults.push(failure);
  tallyResults([failure], tally);
}

function recordGlobalFailure(
  progress: SqaaProgress,
  tally: RunTally,
  chunkIndex: number,
  error: Error,
): void {
  progress.updateChunk(chunkIndex, 'failed');
  tally.globalError = error;
}

function recordChunkFailure(
  progress: SqaaProgress,
  tally: RunTally,
  chunkIndex: number,
  fileIndices: number[],
  chunkPaths: SqaaPath[],
  error: Error,
): void {
  progress.updateChunk(chunkIndex, 'failed');
  for (let i = 0; i < chunkPaths.length; i++) {
    recordFileFailure(progress, tally, fileIndices[i], chunkPaths[i], error);
  }
}

function skipUnprocessedAfterFailure(ctx: RunContext, tally: RunTally): void {
  const processedFiles = new Set(tally.allResults.map((r) => r.file));
  const firstUnprocessed = ctx.paths.findIndex((p) => !processedFiles.has(p.absolutePath));
  if (firstUnprocessed >= 0) {
    ctx.progress.skipRemaining(firstUnprocessed);
  }
}

function sortResultsByFileOrder(tally: RunTally, paths: SqaaPath[]): void {
  const fileIndexMap = new Map(paths.map((p, i) => [p.absolutePath, i]));
  tally.allResults.sort(
    (a, b) => (fileIndexMap.get(a.file) ?? 0) - (fileIndexMap.get(b.file) ?? 0),
  );
}

export function distributeChunkResponse(
  issues: SqaaIssue[],
  errors: Array<{ code: string; message: string }> | null | undefined,
  chunkPaths: SqaaPath[],
): FileSuccess[] {
  const issuesByServerPath = new Map<string, SqaaIssue[]>();
  const knownServerPaths = new Set(chunkPaths.map((p) => p.serverPath));
  const fallbackServerPath = chunkPaths[0]?.serverPath;

  for (const issue of issues) {
    const serverPath =
      issue.filePath && knownServerPaths.has(issue.filePath) ? issue.filePath : fallbackServerPath;
    if (!serverPath) continue;
    const list = issuesByServerPath.get(serverPath) ?? [];
    list.push(issue);
    issuesByServerPath.set(serverPath, list);
  }

  return chunkPaths.map(({ absolutePath, displayPath, serverPath }, index) => ({
    file: absolutePath,
    filePath: displayPath,
    issues: withDisplayFilePath(issuesByServerPath.get(serverPath) ?? [], displayPath),
    errors: index === 0 ? errors : null,
  }));
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

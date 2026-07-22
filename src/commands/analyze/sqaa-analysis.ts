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

import type { SqaaProgress } from '@/core/ui/components/sqaa-progress.ts';

import { getSqaaRetry503BaseDelayMs } from '../../lib/config-constants.ts';
import type { SqaaAnalysisDepth, SqaaIssue } from '../../sonarqube/client.ts';
import { SqaaForbiddenError } from '../../sonarqube/errors.ts';
import {
  fetchChunkWith413Split,
  MAX_503_RETRIES,
  readSqaaFileContent,
  type SqaaChunkGroupError,
  type SqaaChunkResponse,
} from './sqaa-api.ts';
import type { CloudAuth } from './sqaa-auth.ts';
import { type SqaaChunk, type SqaaChunkFile } from './sqaa-chunking.ts';
import type { SqaaDeepWireDepth } from './sqaa-depth.ts';
import { isPayloadTooLargeCommandError } from './sqaa-errors.ts';

export type FileSuccess = {
  file: string;
  filePath: string;
  issues: SqaaIssue[];
  errors?: Array<{ code: string; message: string }> | null;
};
export type FileFailure = { file: string; filePath: string; failure: Error };
export type FileResult = FileSuccess | FileFailure;

type ChunkPath = { file: string; filePath: string };

export interface RunContext {
  files: string[];
  allPaths: string[];
  cloudAuth: CloudAuth;
  projectKey: string;
  branch: string | undefined;
  progress: SqaaProgress;
  analysisDepth?: SqaaDeepWireDepth;
  displayAnalysisDepth: SqaaAnalysisDepth;
  propagateForbiddenError?: boolean;
}

export interface RunTally {
  allResults: FileResult[];
  totalIssues: number;
  /** API `errors[]` warnings on successfully analyzed files (not HTTP failures). */
  totalErrors: number;
  /** Files that could not be analyzed (HTTP 4xx/5xx, fetch errors, etc.). */
  totalFailures: number;
}

/**
 * Run analyses as sequential multi-file chunks. Returns the merged tally once
 * every chunk has been processed (or fail-fast stops remaining chunks).
 */
export async function runAnalyses(ctx: RunContext): Promise<RunTally> {
  const tally = emptyTally();
  if (ctx.files.length === 0) return tally;

  const fileIndexByAbsolutePath = new Map(ctx.files.map((f, i) => [f, i]));
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

  sortResultsByFileOrder(tally, ctx.files);
  return tally;
}

function emptyTally(): RunTally {
  return { allResults: [], totalIssues: 0, totalErrors: 0, totalFailures: 0 };
}

function prepareChunks(
  ctx: RunContext,
  fileIndexByAbsolutePath: Map<string, number>,
  tally: RunTally,
  progress: SqaaProgress,
): { chunks: SqaaChunk[]; chunkFileIndices: number[][] } {
  const readableChunkFiles: SqaaChunkFile[] = [];
  for (let idx = 0; idx < ctx.files.length; idx++) {
    const file = ctx.files[idx];
    try {
      readableChunkFiles.push({
        absolutePath: file,
        relativePath: ctx.allPaths[idx],
        content: readSqaaFileContent(file),
      });
    } catch (err) {
      recordFileFailure(progress, tally, idx, { file, filePath: ctx.allPaths[idx] }, err as Error);
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
): { partPaths: ChunkPath[]; partIndices: number[] } {
  const partPaths: ChunkPath[] = [];
  const partIndices: number[] = [];
  for (const chunkFile of chunkFiles) {
    const idx = fileIndexByAbsolutePath.get(chunkFile.absolutePath);
    if (idx === undefined) {
      continue;
    }
    partPaths.push({ file: chunkFile.absolutePath, filePath: ctx.allPaths[idx] });
    partIndices.push(idx);
  }
  return { partPaths, partIndices };
}

function chunkPathsForIndices(ctx: RunContext, fileIndices: number[]): ChunkPath[] {
  return fileIndices.map((idx) => ({
    file: ctx.files[idx],
    filePath: ctx.allPaths[idx],
  }));
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
      recordFileFailure(
        progress,
        tally,
        idx,
        { file: failed.absolutePath, filePath: ctx.allPaths[idx] },
        error,
      );
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
      ctx.cloudAuth,
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
    if (err instanceof SqaaForbiddenError && ctx.propagateForbiddenError) {
      throw err;
    }
    recordChunkFailure(ctx.progress, tally, chunkIndex, fileIndices, chunkPaths, err as Error);
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
  chunkPaths: ChunkPath[],
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
  chunkPath: ChunkPath,
  error: Error,
): void {
  progress.update(fileIndex, 'failed');
  const failure: FileFailure = {
    file: chunkPath.file,
    filePath: chunkPath.filePath,
    failure: error,
  };
  tally.allResults.push(failure);
  tallyResults([failure], tally);
}

function recordChunkFailure(
  progress: SqaaProgress,
  tally: RunTally,
  chunkIndex: number,
  fileIndices: number[],
  chunkPaths: ChunkPath[],
  error: Error,
): void {
  progress.updateChunk(chunkIndex, 'failed');
  for (let i = 0; i < chunkPaths.length; i++) {
    recordFileFailure(progress, tally, fileIndices[i], chunkPaths[i], error);
  }
}

function skipUnprocessedAfterFailure(ctx: RunContext, tally: RunTally): void {
  const processedFiles = new Set(tally.allResults.map((r) => r.file));
  const firstUnprocessed = ctx.files.findIndex((f) => !processedFiles.has(f));
  if (firstUnprocessed >= 0) {
    ctx.progress.skipRemaining(firstUnprocessed);
  }
}

function sortResultsByFileOrder(tally: RunTally, files: string[]): void {
  const fileIndexMap = new Map(files.map((f, i) => [f, i]));
  tally.allResults.sort(
    (a, b) => (fileIndexMap.get(a.file) ?? 0) - (fileIndexMap.get(b.file) ?? 0),
  );
}

export function distributeChunkResponse(
  issues: SqaaIssue[],
  errors: Array<{ code: string; message: string }> | null | undefined,
  chunkPaths: ChunkPath[],
): FileSuccess[] {
  const issuesByPath = new Map<string, SqaaIssue[]>();
  const knownPaths = new Set(chunkPaths.map((p) => p.filePath));
  const fallbackPath = chunkPaths[0]?.filePath;

  for (const issue of issues) {
    const path = issue.filePath && knownPaths.has(issue.filePath) ? issue.filePath : fallbackPath;
    if (!path) continue;
    const list = issuesByPath.get(path) ?? [];
    list.push(issue);
    issuesByPath.set(path, list);
  }

  return chunkPaths.map(({ file, filePath }, index) => ({
    file,
    filePath,
    issues: issuesByPath.get(filePath) ?? [],
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

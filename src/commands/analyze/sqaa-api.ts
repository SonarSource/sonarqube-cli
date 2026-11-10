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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { getSqaaRetry503BaseDelayMs } from '@/core/config-constants.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import {
  RequestPayloadTooLargeError,
  ServiceUnavailableError,
  SqaaForbiddenError,
} from '@/core/server/errors.ts';

import { SqaaAnalysisClient } from './sqaa-analysis-client.ts';
import { type PackChunksLimits, packFilesIntoChunks, type SqaaChunkFile } from './sqaa-chunking.ts';
import type { SqaaDeepWireDepth } from './sqaa-depth.ts';
import {
  isGlobalSqaaError,
  payloadTooLargeCommandError,
  toSqaaCommandError,
} from './sqaa-errors.ts';
import { partitionSqaaAnalysisFiles, type SqaaFileValidationRejection } from './sqaa-validation.ts';
import type { SqaaAnalysisFile, SqaaAnalysisRequest, SqaaIssue } from './sqaa-wire-types.ts';

/** Maximum number of retries on 503 responses. */
export const MAX_503_RETRIES = 3;

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

function isRetryableSqaaError(err: unknown, includePayloadTooLarge: boolean): boolean {
  if (err instanceof ServiceUnavailableError) {
    return true;
  }
  return includePayloadTooLarge && err instanceof RequestPayloadTooLargeError;
}

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

async function postPreparedSqaaAnalysis(
  connection: SonarConnection,
  request: SqaaAnalysisRequest,
  includePayloadTooLarge = false,
): Promise<SqaaChunkResponse> {
  try {
    return await new SqaaAnalysisClient(connection.httpClient).createAnalysis(request);
  } catch (err) {
    if (err instanceof SqaaForbiddenError || isRetryableSqaaError(err, includePayloadTooLarge)) {
      throw err;
    }
    throw toSqaaCommandError(err);
  }
}

export function fetchPreparedSqaaWithRetry(
  connection: SonarConnection,
  request: SqaaAnalysisRequest,
  onRetry?: (attempt: number) => Promise<void>,
): Promise<SqaaChunkResponse> {
  return with503Retry(() => postPreparedSqaaAnalysis(connection, request), onRetry);
}

async function with503Retry<T>(
  attemptRequest: () => Promise<T>,
  onRetry?: (attempt: number) => Promise<void>,
): Promise<T> {
  let lastServiceError: ServiceUnavailableError | undefined;
  for (let attempt = 1; attempt <= MAX_503_RETRIES + 1; attempt++) {
    try {
      return await attemptRequest();
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
    `Vortex analysis failed after ${MAX_503_RETRIES} retries. The service is still unavailable.`,
    { cause: lastServiceError },
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

export async function fetchChunkWith413Split(
  connection: SonarConnection,
  projectKey: string,
  chunkFiles: SqaaChunkFile[],
  branch: string | undefined,
  onRetry?: (attempt: number) => Promise<void>,
  onPayloadSplit?: () => void,
  analysisDepth?: SqaaDeepWireDepth,
): Promise<SqaaChunkFetchResult> {
  const { valid, rejected } = partitionSqaaAnalysisFiles(toAnalysisFiles(chunkFiles), {
    analysisDepth,
  });
  const result = await fetchPreparedChunkWith413Split(
    connection,
    {
      ...(connection.auth.orgKey ? { organizationKey: connection.auth.orgKey } : {}),
      projectKey,
      ...(branch ? { branchName: branch } : {}),
      ...(analysisDepth ? { analysisDepth } : {}),
      files: valid,
    },
    validChunkFilesAfterRejection(chunkFiles, rejected),
    onRetry,
    onPayloadSplit,
  );
  return {
    parts: result.parts,
    groupErrors: [...validationGroupErrors(rejected, chunkFiles), ...result.groupErrors],
  };
}

export async function fetchPreparedChunkWith413Split(
  connection: SonarConnection,
  request: SqaaAnalysisRequest,
  chunkFiles: SqaaChunkFile[],
  onRetry?: (attempt: number) => Promise<void>,
  onPayloadSplit?: () => void,
): Promise<SqaaChunkFetchResult> {
  if (request.files.length === 0) return { parts: [], groupErrors: [] };
  try {
    const response = await with503Retry(
      () => postPreparedSqaaAnalysis(connection, request, true),
      onRetry,
    );
    return { parts: [{ response, files: chunkFiles }], groupErrors: [] };
  } catch (err) {
    if (!(err instanceof RequestPayloadTooLargeError)) throw err;
    if (chunkFiles.length === 1) {
      return {
        parts: [],
        groupErrors: [{ files: chunkFiles, error: payloadTooLargeCommandError(err) }],
      };
    }
    onPayloadSplit?.();
    const groups = splitChunkFiles(chunkFiles, {
      ...request,
      ...(err.meta?.maxRequestSize == null ? {} : { maxRequestBytes: err.meta.maxRequestSize }),
      ...(err.meta?.maxFiles == null ? {} : { maxFilesPerRequest: err.meta.maxFiles }),
    });
    const parts: SqaaChunkPart[] = [];
    const groupErrors: SqaaChunkGroupError[] = [];
    let offset = 0;
    for (const group of groups) {
      const files = request.files.slice(offset, offset + group.length);
      offset += group.length;
      try {
        const result = await fetchPreparedChunkWith413Split(
          connection,
          { ...request, files },
          group,
          onRetry,
          onPayloadSplit,
        );
        parts.push(...result.parts);
        groupErrors.push(...result.groupErrors);
      } catch (error) {
        if (isGlobalSqaaError(error)) throw error;
        groupErrors.push({ files: group, error: error as Error });
      }
    }
    return { parts, groupErrors };
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
    await sleep(delayMs);
  }
}

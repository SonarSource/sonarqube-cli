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

// Pack SQAA request files into sub-chunks when splitting after a 413 response.

import type { SqaaAnalysisFile, SqaaAnalysisRequest } from '../../../sonarqube/client';

export interface SqaaChunkFile {
  /** Absolute path on disk (for reading / error reporting). */
  absolutePath: string;
  /** Project-relative POSIX path sent to SQAA. */
  relativePath: string;
  content: string;
}

export interface SqaaChunk {
  files: SqaaChunkFile[];
}

export interface PackChunksLimits {
  maxRequestBytes?: number;
  maxFilesPerRequest?: number;
  organizationKey?: string;
  projectKey?: string;
  branchName?: string;
}

export interface EstimateRequestParams {
  organizationKey: string;
  projectKey: string;
  branchName?: string;
  files: SqaaAnalysisFile[];
}

/** Build the JSON body used for a DEEP multi-file SQAA request. */
export function buildDeepAnalysisRequest(params: EstimateRequestParams): SqaaAnalysisRequest {
  return {
    organizationKey: params.organizationKey,
    projectKey: params.projectKey,
    ...(params.branchName ? { branchName: params.branchName } : {}),
    analysisDepth: 'DEEP',
    files: params.files,
  };
}

/** Estimated UTF-8 byte size of a DEEP analysis request body. */
export function estimateRequestBytes(params: EstimateRequestParams): number {
  return Buffer.byteLength(JSON.stringify(buildDeepAnalysisRequest(params)), 'utf8');
}

const EMPTY_ENVELOPE_PARAMS = { organizationKey: '', projectKey: '' } as const;

function envelopeParams(limits: PackChunksLimits): EstimateRequestParams {
  return {
    organizationKey: limits.organizationKey ?? EMPTY_ENVELOPE_PARAMS.organizationKey,
    projectKey: limits.projectKey ?? EMPTY_ENVELOPE_PARAMS.projectKey,
    ...(limits.branchName ? { branchName: limits.branchName } : {}),
    files: [],
  };
}

/** Byte size of the DEEP request JSON wrapper with an empty `files` array. */
function deepRequestEnvelopeBytes(limits: PackChunksLimits): number {
  return estimateRequestBytes(envelopeParams(limits));
}

function analysisFileJsonBytes(file: SqaaAnalysisFile): number {
  return Buffer.byteLength(JSON.stringify(file), 'utf8');
}

/**
 * Greedy pack using explicit byte and file-count limits (from a 413 response meta).
 * Omit a limit to impose no constraint on that dimension.
 */
export function packFilesIntoChunks(
  items: SqaaChunkFile[],
  limits: PackChunksLimits = {},
): SqaaChunk[] {
  const maxRequestBytes = limits.maxRequestBytes ?? Number.POSITIVE_INFINITY;
  const maxFilesPerRequest = limits.maxFilesPerRequest ?? Number.POSITIVE_INFINITY;

  if (items.length === 0) {
    return [];
  }

  const envelopeBytes = deepRequestEnvelopeBytes(limits);
  const itemByteCosts = items.map((item) => analysisFileJsonBytes(toAnalysisFile(item)));

  const chunks: SqaaChunk[] = [];
  let current: SqaaChunkFile[] = [];
  let currentBytes = envelopeBytes;

  const flush = (): void => {
    if (current.length > 0) {
      chunks.push({ files: current });
      current = [];
      currentBytes = envelopeBytes;
    }
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemBytes = itemByteCosts[i];
    const candidateLength = current.length + 1;
    const candidateBytes =
      current.length === 0 ? envelopeBytes + itemBytes : currentBytes + 1 + itemBytes;

    if (
      current.length > 0 &&
      (candidateBytes > maxRequestBytes || candidateLength > maxFilesPerRequest)
    ) {
      flush();
      current = [item];
      currentBytes = envelopeBytes + itemBytes;
      continue;
    }

    current.push(item);
    currentBytes = candidateBytes;
  }

  flush();
  return chunks;
}

function toAnalysisFile(file: SqaaChunkFile): SqaaAnalysisFile {
  return { path: file.relativePath, content: file.content };
}
